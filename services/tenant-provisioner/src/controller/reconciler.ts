import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ControllerConfig } from "./config.js";
import { EvidenceContractError, validateEvidence } from "./evidence.js";
import {
  KubernetesDependencyError,
  type ControllerKubernetesClient,
  type KubernetesObject,
} from "./kubernetes.js";
import { ProviderDependencyError, type WorkspaceProvider } from "./provider.js";
import {
  ResourceContractError,
  buildActiveResources,
  buildConfigurationJob,
  buildExternalSecret,
  buildSuspendedResources,
  resourceNames,
} from "./resources.js";
import {
  provisioningSteps,
  type ProvisioningStep,
  type TenantWorkspace,
  type WorkspaceCondition,
} from "../types.js";

const CONDITION_BY_STEP: Record<ProvisioningStep | "suspend" | "resume_prepare" | "resume", string> = {
  identity: "IdentityReady",
  database: "DatabaseReady",
  search: "SearchReady",
  storage: "StorageReady",
  secrets: "SecretsReady",
  zammad: "ZammadReady",
  package: "PackageReady",
  oidc: "OidcReady",
  defaults: "DefaultsReady",
  health: "Healthy",
  suspend: "Suspended",
  resume_prepare: "ResumePrepared",
  resume: "Resumed",
};

class PendingEvidenceError extends Error {
  constructor(readonly reason: string) {
    super("The tenant workspace is still reconciling.");
    this.name = "PendingEvidenceError";
  }
}

export class ControllerLeadershipLostError extends Error {
  constructor() {
    super("The controller no longer holds a safe reconciliation lease.");
    this.name = "ControllerLeadershipLostError";
  }
}

export class WorkspaceControllerReconciler {
  constructor(
    private readonly config: ControllerConfig,
    private readonly kubernetes: ControllerKubernetesClient,
    private readonly provider: WorkspaceProvider,
    private readonly hasLeadership: () => boolean = () => true,
  ) {}

  async reconcile(workspace: TenantWorkspace) {
    this.assertLeadership();
    validateWorkspace(workspace, this.config);
    await this.assertCurrentWorkspace(workspace);
    const key: ProvisioningStep | "suspend" | "resume_prepare" | "resume" = workspace.spec.request.action === "SUSPEND"
      ? "suspend"
      : workspace.spec.request.action === "RESUME"
        ? workspace.spec.request.resumePhase === "PREPARE" ? "resume_prepare" : "resume"
        : workspace.spec.request.desiredStep as ProvisioningStep;
    if (key !== "suspend" && key !== "resume_prepare" && key !== "resume" && !provisioningSteps.includes(key)) {
      return this.writeCondition(workspace, key as ProvisioningStep, "False", "InvalidSpec", undefined);
    }
    let verifiedStatusWrite = false;
    let publishedIngress: KubernetesObject | undefined;
    try {
      validatePriorEvidence(workspace);
      const evidence = key === "suspend"
        ? await this.reconcileSuspension(workspace)
        : key === "resume_prepare"
          ? await this.reconcileResumptionPreparation(workspace)
          : key === "resume"
          ? await this.reconcileResumptionPublication(workspace, (resource) => { publishedIngress = resource; })
          : await this.reconcileStep(workspace, key, (resource) => { publishedIngress = resource; });
      const outputs = validateEvidence(workspace, key, evidence, true);
      return await this.writeCondition(
        workspace,
        key,
        "True",
        "Verified",
        outputs,
        () => { verifiedStatusWrite = true; },
      );
    } catch (error) {
      if (error instanceof ControllerLeadershipLostError) throw error;
      if (error instanceof StaleWorkspaceSnapshotError) {
        if (
          (key === "health" && !currentSuccess(workspace, "Healthy", this.config.identity)) ||
          (key === "resume" && !currentSuccess(workspace, "Resumed", this.config.identity))
        ) await this.compensateIngress(workspace, publishedIngress);
        throw error;
      }
      if (verifiedStatusWrite) throw error;
      if (publishedIngress) await this.compensateIngress(workspace, publishedIngress);
      else if (key === "health" || key === "resume") await this.holdIngress(workspace);
      if (error instanceof PendingEvidenceError) {
        return this.writeCondition(workspace, key, "Unknown", error.reason, undefined);
      }
      if (error instanceof KubernetesDependencyError || error instanceof ProviderDependencyError) {
        return this.writeCondition(
          workspace,
          key,
          error.retryable ? "Unknown" : "False",
          error.retryable ? "DependencyUnavailable" : "PolicyDenied",
          undefined,
        );
      }
      if (error instanceof ResourceContractError) {
        return this.writeCondition(workspace, key, "False", "UnsupportedVersion", undefined);
      }
      if (error instanceof EvidenceContractError) {
        return this.writeCondition(workspace, key, "False", "TerminalFailure", undefined);
      }
      throw error;
    }
  }

  private async reconcileStep(
    workspace: TenantWorkspace,
    step: ProvisioningStep,
    ingressApplied: (resource: KubernetesObject) => void,
  ) {
    switch (step) {
      case "identity":
      case "database":
      case "search":
      case "storage":
        return this.executeProvider(step, workspace);
      case "secrets": {
        const externalSecret = await this.applyOwned(
          buildExternalSecret(workspace, this.config),
          workspace,
        );
        requireExternalSecretReady(externalSecret);
        return this.executeProvider("verify", workspace);
      }
      case "zammad":
        await this.ensureActiveRuntime(workspace);
        return {
          ...await this.executeProvider("verify", workspace),
          runtime_image: workspace.spec.zammad.image,
          package_version: workspace.spec.zammad.packageVersion,
          package_sha256: workspace.spec.zammad.packageSha256,
        };
      case "package":
      case "oidc":
      case "defaults": {
        await this.ensureActiveRuntime(workspace);
        await this.completeOwnedJob(
          workspace,
          buildConfigurationJob(workspace, this.config, step),
        );
        return this.executeProvider("verify", workspace);
      }
      case "health": {
        const published = currentSuccess(workspace, "Healthy", this.config.identity);
        const authorized = published || currentPublicationAuthorization(workspace, "Healthy", this.config.identity);
        await this.ensureActiveRuntime(workspace, !published);
        const health = validateEvidence(
          workspace,
          "health",
          await this.executeProvider("verify", workspace),
          true,
        );
        if (!authorized) throw new PendingEvidenceError("PublicationAuthorized");
        await this.publishIngress(workspace, ingressApplied);
        return health;
      }
    }
  }

  private async ensureActiveRuntime(workspace: TenantWorkspace, holdIngress = true) {
    if (holdIngress) await this.holdIngress(workspace);
    const externalSecret = await this.applyOwned(
      buildExternalSecret(workspace, this.config),
      workspace,
    );
    const resources = buildActiveResources(workspace, this.config);
    const pvc = await this.applyOwned(resources.pvc, workspace);
    const redisPvc = await this.applyOwned(resources.redisPvc, workspace);
    await this.applyOwned(resources.nginxConfig, workspace);
    for (const service of resources.services) {
      await this.applyOwned(service, workspace);
    }
    await this.applyOwned(resources.networkPolicy, workspace);
    requireExternalSecretReady(externalSecret);
    requirePvcBound(pvc);
    requirePvcBound(redisPvc);

    // zammad-init talks to both Redis and Memcached. Bring up and verify only
    // those dependency deployments before the root-only one-shot init Job;
    // ordinary Zammad runtimes are intentionally held back until init exits.
    const dependencyNames = new Set([resourceNames(workspace).redis, resourceNames(workspace).memcached]);
    const dependencyDeployments = resources.deployments.filter((deployment) =>
      dependencyNames.has(deployment.metadata.name)
    );
    const runtimeDeployments = resources.deployments.filter((deployment) =>
      !dependencyNames.has(deployment.metadata.name)
    );
    for (const deployment of dependencyDeployments) {
      const applied = await this.applyOwned(deployment, workspace);
      requireDeploymentAvailable(applied, deployment);
    }

    await this.completeOwnedJob(workspace, resources.initJob);
    for (const deployment of runtimeDeployments) {
      requireDeploymentAvailable(
        await this.applyOwned(deployment, workspace),
        deployment,
      );
    }
    await this.applyOwned(resources.pdb, workspace);
    requireExactPodImages(
      await this.applyOwned(resources.backup, workspace),
      resources.backup,
    );
  }

  private async completeOwnedJob(workspace: TenantWorkspace, desired: KubernetesObject) {
    const existing = await this.getResource(desired.apiVersion, desired.kind, desired.metadata.name);
    if (existing) {
      requireWorkspaceOwner(existing, workspace);
      const attemptedFence = ownedResourceFence(existing, "CONFIGURATION_JOB_FENCE_INVALID");
      if (attemptedFence > workspace.spec.request.fencingToken) {
        throw new KubernetesDependencyError(false, "STALE_WORKSPACE_FENCE");
      }
      if (attemptedFence === workspace.spec.request.fencingToken && jobFailed(existing)) {
        throw new EvidenceContractError("CONFIGURATION_JOB_FAILED");
      }
      if (attemptedFence < workspace.spec.request.fencingToken && !jobComplete(existing)) {
        await this.deleteOwned(desired.apiVersion, desired.kind, desired.metadata.name, workspace, existing);
        if (await this.getResource(desired.apiVersion, desired.kind, desired.metadata.name)) {
          throw new PendingEvidenceError("ConfigurationJobTerminationPending");
        }
        throw new PendingEvidenceError("ConfigurationJobRetryPending");
      }
    }
    requireJobComplete(await this.applyOwned(desired, workspace), desired);
  }

  private async holdIngress(workspace: TenantWorkspace) {
    const names = resourceNames(workspace);
    await this.deleteOwned("networking.k8s.io/v1", "Ingress", names.ingress, workspace);
    if (await this.getResource("networking.k8s.io/v1", "Ingress", names.ingress)) {
      throw new PendingEvidenceError("IngressRemovalPending");
    }
  }

  private async publishIngress(workspace: TenantWorkspace, ingressApplied: (resource: KubernetesObject) => void) {
    const ingress = buildActiveResources(workspace, this.config).ingress;
    await this.assertCurrentWorkspace(workspace);
    const applied = await this.kubernetes.applyOwned(ingress, workspace.spec.tenantId);
    ingressApplied(applied);
    await this.assertCurrentWorkspace(workspace);
    const observed = await this.getResource(ingress.apiVersion, ingress.kind, ingress.metadata.name);
    if (!observed) throw new PendingEvidenceError("IngressActivationPending");
    ingressApplied(observed);
    requireOwnedIngress(observed, ingress, applied, workspace, this.config);
  }

  private async compensateIngress(workspace: TenantWorkspace, expected?: KubernetesObject) {
    if (!expected) return;
    try {
      await this.kubernetes.deleteOwned(
        expected.apiVersion,
        expected.kind,
        expected.metadata.name,
        workspace.spec.tenantId,
        workspace.spec.request.fencingToken,
        expected,
      );
    } catch {
      // A changed or higher-fence ingress belongs to the authoritative reconcile.
    }
  }

  private async reconcileSuspension(workspace: TenantWorkspace) {
    const names = resourceNames(workspace);
    const suspended = buildSuspendedResources(workspace, this.config);
    const deployments: KubernetesObject[] = [];
    for (const deployment of suspended.deployments) {
      deployments.push(await this.applyOwned(deployment, workspace));
    }
    const backup = await this.applyOwned(suspended.backup, workspace);
    const jobs = await this.listOwned("batch/v1", "Job", workspace.spec.tenantId);
    for (const job of jobs) {
      await this.requireWorkspaceJobOwner(job, workspace, names.backup);
      if (ownedResourceFence(job, "CONFIGURATION_JOB_FENCE_INVALID") > workspace.spec.request.fencingToken) {
        throw new KubernetesDependencyError(false, "STALE_WORKSPACE_FENCE");
      }
      if (job.metadata.name.startsWith(`${names.base}-init-`) && jobComplete(job)) continue;
      await this.deleteOwned("batch/v1", "Job", job.metadata.name, workspace, job);
    }
    await this.deleteOwned("networking.k8s.io/v1", "Ingress", names.ingress, workspace);
    await this.deleteOwned("external-secrets.io/v1beta1", "ExternalSecret", names.runtimeSecret, workspace);
    for (const deployment of deployments) requireDeploymentScaledDown(deployment);
    if (backup.spec?.suspend !== true) throw new PendingEvidenceError("BackupSuspensionPending");
    const remainingJobs = await this.listOwned("batch/v1", "Job", workspace.spec.tenantId);
    for (const job of remainingJobs) await this.requireWorkspaceJobOwner(job, workspace, names.backup);
    if (remainingJobs.some((job) => !job.metadata.name.startsWith(`${names.base}-init-`) || !jobComplete(job))) {
      throw new PendingEvidenceError("ConfigurationJobTerminationPending");
    }
    if (await this.getResource("networking.k8s.io/v1", "Ingress", names.ingress)) {
      throw new PendingEvidenceError("IngressRemovalPending");
    }
    if (await this.getResource("external-secrets.io/v1beta1", "ExternalSecret", names.runtimeSecret)) {
      throw new PendingEvidenceError("CredentialMaterialRemovalPending");
    }
    return this.executeProvider("suspend", workspace);
  }

  private async reconcileResumptionPreparation(workspace: TenantWorkspace) {
    const names = resourceNames(workspace);
    // The provider transition reverses the durable credential suspension. It
    // is fenced and verified before any workload is allowed to consume those
    // credentials. Public ingress is actively held absent throughout prepare.
    await this.deleteOwned("networking.k8s.io/v1", "Ingress", names.ingress, workspace);
    if (await this.getResource("networking.k8s.io/v1", "Ingress", names.ingress)) {
      throw new PendingEvidenceError("IngressRemovalPending");
    }
    const providerResume = validateProviderResumeEvidence(
      await this.executeProvider("resume", workspace),
      workspace,
    );
    await this.ensureActiveRuntime(workspace);
    const health = validateEvidence(
      workspace,
      "health",
      await this.executeProvider("verify", workspace),
      true,
    );
    if (await this.getResource("networking.k8s.io/v1", "Ingress", names.ingress)) {
      throw new KubernetesDependencyError(false, "INGRESS_EXPOSED_DURING_PREPARE");
    }
    return {
      prepared: true,
      credentials_enabled: true,
      workloads_ready: true,
      healthy: true,
      isolation_verified: true,
      zammad_base_url: health.zammad_base_url,
      provider_resumed_at: providerResume.provider_resumed_at,
      checked_at: health.checked_at,
    };
  }

  private async reconcileResumptionPublication(
    workspace: TenantWorkspace,
    ingressApplied: (resource: KubernetesObject) => void,
  ) {
    const prepared = workspace.status?.outputs?.resume_prepare;
    validateEvidence(workspace, "resume_prepare", prepared, false);
    // Re-check the private runtime under the current fence. The database has
    // already authorized ACTIVE at this point; ingress is the final publish.
    const published = currentSuccess(workspace, "Resumed", this.config.identity);
    const authorized = published || currentPublicationAuthorization(workspace, "Resumed", this.config.identity);
    await this.ensureActiveRuntime(workspace, !published);
    const health = validateEvidence(
      workspace,
      "health",
      await this.executeProvider("verify", workspace),
      true,
    );
    if (!authorized) throw new PendingEvidenceError("PublicationAuthorized");
    await this.publishIngress(workspace, ingressApplied);
    return {
      resumed: true,
      ingress_enabled: true,
      healthy: true,
      isolation_verified: true,
      zammad_base_url: health.zammad_base_url,
      resumed_at: new Date().toISOString(),
      checked_at: health.checked_at,
    };
  }

  private async writeCondition(
    workspace: TenantWorkspace,
    key: ProvisioningStep | "suspend" | "resume_prepare" | "resume",
    status: WorkspaceCondition["status"],
    reason: string,
    output: Record<string, unknown> | undefined,
    statusWriteAttempted?: () => void,
  ) {
    const generation = workspace.metadata.generation;
    if (!Number.isSafeInteger(generation) || Number(generation) < 1) {
      throw new KubernetesDependencyError(false, "WORKSPACE_GENERATION_INVALID");
    }
    const currentFence = workspace.status?.observedFencingToken;
    if (currentFence !== undefined && currentFence > workspace.spec.request.fencingToken) {
      throw new KubernetesDependencyError(false, "STALE_WORKSPACE_FENCE");
    }
    const type = CONDITION_BY_STEP[key];
    const condition: WorkspaceCondition = {
      type,
      status,
      reason,
      message: status === "True"
        ? "The requested tenant workspace step was verified."
        : status === "False"
          ? "The requested tenant workspace step was rejected."
          : "The requested tenant workspace step is still reconciling.",
      observedGeneration: Number(generation),
    };
    const conditions = [
      ...(workspace.status?.conditions ?? []).filter((entry) => entry.type !== type),
      condition,
    ];
    const outputs = { ...(workspace.status?.outputs ?? {}) };
    if (output === undefined) delete outputs[key];
    else outputs[key] = output;
    const nextStatus: NonNullable<TenantWorkspace["status"]> = {
      observedGeneration: Number(generation),
      observedFencingToken: workspace.spec.request.fencingToken,
      lastAppliedIdempotencyKey: workspace.spec.request.idempotencyKey,
      reconciler: this.config.identity,
      conditions,
      outputs,
    };
    if (JSON.stringify(workspace.status ?? {}) === JSON.stringify(nextStatus)) return workspace;
    return this.replaceWorkspaceStatus(workspace, nextStatus, statusWriteAttempted);
  }

  private assertLeadership() {
    if (!this.hasLeadership()) throw new ControllerLeadershipLostError();
  }

  private async applyOwned(resource: KubernetesObject, workspace: TenantWorkspace) {
    await this.assertCurrentWorkspace(workspace);
    const result = await this.kubernetes.applyOwned(resource, workspace.spec.tenantId);
    await this.assertCurrentWorkspace(workspace);
    return result;
  }

  private async deleteOwned(
    apiVersion: string,
    kind: string,
    name: string,
    workspace: TenantWorkspace,
    expected?: KubernetesObject,
  ) {
    await this.assertCurrentWorkspace(workspace);
    await this.kubernetes.deleteOwned(
      apiVersion,
      kind,
      name,
      workspace.spec.tenantId,
      workspace.spec.request.fencingToken,
      expected,
    );
    await this.assertCurrentWorkspace(workspace);
  }

  private async getResource(apiVersion: string, kind: string, name: string) {
    this.assertLeadership();
    const result = await this.kubernetes.getResource(apiVersion, kind, name);
    this.assertLeadership();
    return result;
  }

  private async listOwned(apiVersion: string, kind: string, tenantId: string) {
    this.assertLeadership();
    const result = await this.kubernetes.listOwned(apiVersion, kind, tenantId);
    this.assertLeadership();
    return result;
  }

  private async executeProvider(action: Parameters<WorkspaceProvider["execute"]>[0], workspace: TenantWorkspace) {
    await this.assertCurrentWorkspace(workspace);
    const result = await this.provider.execute(action, workspace);
    await this.assertCurrentWorkspace(workspace);
    return result;
  }

  private async replaceWorkspaceStatus(
    workspace: TenantWorkspace,
    status: NonNullable<TenantWorkspace["status"]>,
    statusWriteAttempted?: () => void,
  ) {
    await this.assertCurrentWorkspace(workspace);
    statusWriteAttempted?.();
    const result = await this.kubernetes.replaceWorkspaceStatus(workspace, status);
    this.assertLeadership();
    return result;
  }

  private async requireWorkspaceJobOwner(job: KubernetesObject, workspace: TenantWorkspace, backupName: string) {
    if (hasWorkspaceOwner(job, workspace)) return;
    const cronOwner = job.metadata.ownerReferences?.find((entry) =>
      entry.apiVersion === "batch/v1" && entry.kind === "CronJob" && entry.name === backupName && typeof entry.uid === "string"
    );
    if (!cronOwner) throw new KubernetesDependencyError(false, "RESOURCE_OWNERSHIP_DENIED");
    const cronJob = await this.getResource("batch/v1", "CronJob", backupName);
    if (!cronJob || cronJob.metadata.uid !== cronOwner.uid) {
      throw new KubernetesDependencyError(false, "RESOURCE_OWNERSHIP_DENIED");
    }
    requireWorkspaceOwner(cronJob, workspace);
  }

  private async assertCurrentWorkspace(workspace: TenantWorkspace) {
    this.assertLeadership();
    const current = await this.kubernetes.getWorkspace(workspace.metadata.name);
    this.assertLeadership();
    if (
      !current ||
      current.metadata.uid !== workspace.metadata.uid ||
      current.metadata.resourceVersion !== workspace.metadata.resourceVersion ||
      current.metadata.generation !== workspace.metadata.generation ||
      !isDeepStrictEqual(current.spec, workspace.spec)
    ) throw new StaleWorkspaceSnapshotError();
  }
}

function hasWorkspaceOwner(resource: KubernetesObject, workspace: TenantWorkspace) {
  return resource.metadata.ownerReferences?.some((entry) =>
    entry.apiVersion === workspace.apiVersion &&
    entry.kind === workspace.kind &&
    entry.name === workspace.metadata.name &&
    entry.uid === workspace.metadata.uid &&
    entry.controller === true
  ) === true;
}

function requireWorkspaceOwner(resource: KubernetesObject, workspace: TenantWorkspace) {
  if (!hasWorkspaceOwner(resource, workspace)) {
    throw new KubernetesDependencyError(false, "RESOURCE_OWNERSHIP_DENIED");
  }
}

function validateWorkspace(workspace: TenantWorkspace, config: ControllerConfig) {
  const tenantId = workspace.spec?.tenantId;
  const request = workspace.spec?.request;
  const compact = tenantId?.replaceAll("-", "");
  if (
    workspace.metadata.namespace !== config.namespace ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(tenantId) ||
    workspace.metadata.name !== `tenant-${tenantId}` ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(workspace.metadata.uid ?? "") ||
    !Number.isSafeInteger(workspace.metadata.generation) ||
    Number(workspace.metadata.generation) < 1 ||
    typeof workspace.metadata.resourceVersion !== "string" ||
    !request ||
    !Number.isSafeInteger(request.fencingToken) ||
    request.fencingToken < 1 ||
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length > 240 ||
    workspace.spec.zammad.hostname !== `${workspace.spec.slug}.${config.baseDomain}` ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(workspace.spec.zammad.instanceId) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(workspace.spec.zammad.version) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(workspace.spec.zammad.packageVersion) ||
    !/^[0-9a-f]{64}$/u.test(workspace.spec.zammad.packageSha256) ||
    [
      workspace.spec.zammad.image,
      workspace.spec.zammad.configuratorImage,
      workspace.spec.zammad.nginxImage,
      workspace.spec.zammad.redisImage,
      workspace.spec.zammad.memcachedImage,
    ].some((image) => !/^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/u.test(image)) ||
    workspace.spec.oidc.disablePasswordLogin !== true ||
    workspace.spec.database.isolation !== "DedicatedDatabaseAndRole" ||
    workspace.spec.database.databaseName !== `zammad_${compact}` ||
    workspace.spec.database.roleName !== `zammad_${compact}` ||
    workspace.spec.search.isolation !== "DedicatedNamespaceAndCredential" ||
    workspace.spec.search.namespace !== `wasalx_${compact}` ||
    workspace.spec.storage.isolation !== "DedicatedPrefixAndCredential" ||
    workspace.spec.storage.prefix !== `tenants/${tenantId}/` ||
    workspace.spec.oidc.clientId !== `wasalx-${compact}` ||
    workspace.spec.defaults.retentionDays !== workspace.spec.retentionDays ||
    workspace.spec.database.secretReference !== `secret://tenants/${tenantId}/zammad/database` ||
    workspace.spec.search.secretReference !== `secret://tenants/${tenantId}/zammad/search` ||
    workspace.spec.storage.secretReference !== `secret://tenants/${tenantId}/zammad/storage` ||
    workspace.spec.secrets.serviceSecretReference !== `secret://tenants/${tenantId}/zammad/service` ||
    workspace.spec.secrets.privacySecretReference !== `secret://tenants/${tenantId}/zammad/privacy` ||
    workspace.spec.oidc.secretReference !== `secret://tenants/${tenantId}/zammad/oidc`
  ) throw new KubernetesDependencyError(false, "WORKSPACE_SPEC_INVALID");
  if (
    !Array.isArray(request.completedSteps) ||
    request.completedSteps.some((step, index) => step !== provisioningSteps[index])
  ) throw new KubernetesDependencyError(false, "WORKSPACE_STEP_HISTORY_INVALID");
  if (
    request.action === "PROVISION" &&
    (workspace.spec.desiredState !== "Active" ||
      request.resumePhase !== undefined ||
      request.desiredStep !== provisioningSteps[request.completedSteps.length] ||
      request.idempotencyKey !== `provision:${tenantId}:${request.operationId}:${request.desiredStep}`)
  ) throw new KubernetesDependencyError(false, "WORKSPACE_STATE_INVALID");
  if (
    request.action === "SUSPEND" &&
    (workspace.spec.desiredState !== "Suspended" ||
      request.resumePhase !== undefined ||
      request.desiredStep !== "suspend" ||
      request.completedSteps.length !== provisioningSteps.length ||
      request.idempotencyKey !== `suspend:${tenantId}:${request.operationId}`)
  ) throw new KubernetesDependencyError(false, "WORKSPACE_STATE_INVALID");
  if (
    request.action === "RESUME" &&
    (workspace.spec.desiredState !== "Active" ||
      request.completedSteps.length !== provisioningSteps.length ||
      !["PREPARE", "PUBLISH"].includes(request.resumePhase ?? "") ||
      request.desiredStep !== (request.resumePhase === "PREPARE" ? "resume_prepare" : "resume_publish") ||
      request.idempotencyKey !== `resume:${tenantId}:${request.operationId}:${request.resumePhase?.toLowerCase()}`)
  ) {
    throw new KubernetesDependencyError(false, "WORKSPACE_STATE_INVALID");
  }
  if (!(["PROVISION", "SUSPEND", "RESUME"] as const).includes(request.action)) {
    throw new KubernetesDependencyError(false, "WORKSPACE_STATE_INVALID");
  }
}

class StaleWorkspaceSnapshotError extends Error {
  constructor() {
    super("The tenant workspace changed during reconciliation.");
    this.name = "StaleWorkspaceSnapshotError";
  }
}

function validateProviderResumeEvidence(value: Record<string, unknown>, workspace: TenantWorkspace) {
  if (
    Object.keys(value).length !== 3 ||
    value.resumed !== true ||
    value.credentials_enabled !== true ||
    typeof value.provider_resumed_at !== "string" ||
    !Number.isFinite(Date.parse(value.provider_resumed_at)) ||
    Date.parse(value.provider_resumed_at) < Date.now() - 300_000 ||
    Date.parse(value.provider_resumed_at) > Date.now() + 60_000 ||
    workspace.spec.desiredState !== "Active"
  ) throw new EvidenceContractError("PROVIDER_RESUME_EVIDENCE_INVALID");
  return value as { resumed: true; credentials_enabled: true; provider_resumed_at: string };
}

function validatePriorEvidence(workspace: TenantWorkspace) {
  for (const completed of workspace.spec.request.completedSteps) {
    const output = workspace.status?.outputs?.[completed];
    const condition = workspace.status?.conditions?.find((entry) => entry.type === CONDITION_BY_STEP[completed]);
    if (condition?.status !== "True") throw new EvidenceContractError("PRIOR_CONDITION_MISSING");
    validateEvidence(workspace, completed, output);
  }
}

function requireExternalSecretReady(resource: KubernetesObject) {
  const conditions = arrayOfRecords(resource.status?.conditions);
  if (!conditions.some((condition) => condition.type === "Ready" && condition.status === "True")) {
    throw new PendingEvidenceError("ExternalSecretPending");
  }
}

function requirePvcBound(resource: KubernetesObject) {
  if (resource.status?.phase !== "Bound") throw new PendingEvidenceError("StorageBindingPending");
}

function requireDeploymentAvailable(resource: KubernetesObject, expected: KubernetesObject) {
  const status = resource.status ?? {};
  const conditions = arrayOfRecords(status.conditions);
  const desiredReplicas = Number(expected.spec?.replicas ?? 0);
  const expectedImages = podImages(expected);
  if (
    Number(status.observedGeneration ?? 0) < Number(resource.metadata.generation ?? 1) ||
    Number(status.availableReplicas ?? 0) < desiredReplicas ||
    JSON.stringify(podImages(resource)) !== JSON.stringify(expectedImages) ||
    !conditions.some((condition) => condition.type === "Available" && condition.status === "True")
  ) throw new PendingEvidenceError("ZammadDeploymentPending");
}

function podImages(resource: KubernetesObject) {
  const jobTemplate = resource.kind === "CronJob" && resource.spec?.jobTemplate && typeof resource.spec.jobTemplate === "object"
    ? resource.spec.jobTemplate as Record<string, unknown>
    : undefined;
  const jobSpec = jobTemplate?.spec && typeof jobTemplate.spec === "object"
    ? jobTemplate.spec as Record<string, unknown>
    : undefined;
  const template = resource.kind === "CronJob" ? jobSpec?.template : resource.spec?.template;
  const spec = template && typeof template === "object" && !Array.isArray(template)
    ? (template as Record<string, unknown>).spec
    : undefined;
  const record = spec && typeof spec === "object" && !Array.isArray(spec)
    ? spec as Record<string, unknown>
    : {};
  return [record.initContainers, record.containers]
    .flatMap((value) => arrayOfRecords(value))
    .map((container) => [container.name, container.image]);
}

function requireDeploymentScaledDown(resource: KubernetesObject) {
  if (
    Number(resource.status?.observedGeneration ?? 0) < Number(resource.metadata.generation ?? 1) ||
    Number(resource.spec?.replicas ?? -1) !== 0 ||
    Number(resource.status?.availableReplicas ?? 0) !== 0 ||
    Number(resource.status?.replicas ?? 0) !== 0 ||
    Number(resource.status?.readyReplicas ?? 0) !== 0 ||
    Number(resource.status?.updatedReplicas ?? 0) !== 0
  ) throw new PendingEvidenceError("WorkloadSuspensionPending");
}

function requireOwnedIngress(
  resource: KubernetesObject,
  expected: KubernetesObject,
  applied: KubernetesObject,
  workspace: TenantWorkspace,
  config: ControllerConfig,
) {
  const expectedSpec = JSON.stringify(expected.spec);
  if (
    resource.apiVersion !== "networking.k8s.io/v1" ||
    resource.kind !== "Ingress" ||
    resource.metadata.namespace !== config.namespace ||
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] !== "wasalx-workspace-controller" ||
    resource.metadata.labels?.["wasalx.io/tenant"] !== workspace.spec.tenantId ||
    resource.metadata.labels?.["wasalx.io/plane"] !== "tenant" ||
    resource.metadata.annotations?.["wasalx.io/workspace"] !== workspace.metadata.name ||
    typeof applied.metadata.uid !== "string" ||
    resource.metadata.uid !== applied.metadata.uid ||
    !hasWorkspaceOwner(resource, workspace) ||
    resource.metadata.annotations?.["cert-manager.io/cluster-issuer"] !== config.clusterIssuer ||
    resource.metadata.annotations?.["nginx.ingress.kubernetes.io/ssl-redirect"] !== "true" ||
    resource.metadata.annotations?.["wasalx.io/fencing-token"] !== String(workspace.spec.request.fencingToken) ||
    resource.metadata.annotations?.["wasalx.io/idempotency-key-hash"] !==
      createHash("sha256").update(workspace.spec.request.idempotencyKey).digest("hex") ||
    JSON.stringify(resource.spec) !== expectedSpec
  ) {
    throw new KubernetesDependencyError(false, "INGRESS_OWNERSHIP_INVALID");
  }
}

function requireJobComplete(resource: KubernetesObject, expected: KubernetesObject) {
  const conditions = arrayOfRecords(resource.status?.conditions);
  if (conditions.some((condition) => condition.type === "Failed" && condition.status === "True")) {
    throw new EvidenceContractError("CONFIGURATION_JOB_FAILED");
  }
  if (!conditions.some((condition) => condition.type === "Complete" && condition.status === "True")) {
    throw new PendingEvidenceError("ConfigurationJobPending");
  }
  requireExactPodImages(resource, expected);
}

function requireExactPodImages(resource: KubernetesObject, expected: KubernetesObject) {
  if (JSON.stringify(podImages(resource)) !== JSON.stringify(podImages(expected))) {
    throw new PendingEvidenceError("WorkloadImagePending");
  }
}

function currentSuccess(workspace: TenantWorkspace, type: string, reconciler: string) {
  const generation = workspace.metadata.generation;
  const condition = workspace.status?.conditions?.find((entry) => entry.type === type);
  const current = condition?.status === "True" &&
    condition.observedGeneration === generation &&
    workspace.status?.observedGeneration === generation &&
    workspace.status?.observedFencingToken === workspace.spec.request.fencingToken &&
    workspace.status?.lastAppliedIdempotencyKey === workspace.spec.request.idempotencyKey &&
    workspace.status?.reconciler === reconciler;
  if (!current) return false;
  try {
    validateEvidence(
      workspace,
      type === "Healthy" ? "health" : "resume",
      workspace.status?.outputs?.[type === "Healthy" ? "health" : "resume"],
      false,
    );
    return true;
  } catch {
    return false;
  }
}

function currentPublicationAuthorization(workspace: TenantWorkspace, type: string, reconciler: string) {
  const generation = workspace.metadata.generation;
  const condition = workspace.status?.conditions?.find((entry) => entry.type === type);
  return condition?.status === "Unknown" &&
    condition.reason === "PublicationAuthorized" &&
    condition.observedGeneration === generation &&
    workspace.status?.observedGeneration === generation &&
    workspace.status?.observedFencingToken === workspace.spec.request.fencingToken &&
    workspace.status?.lastAppliedIdempotencyKey === workspace.spec.request.idempotencyKey &&
    workspace.status?.reconciler === reconciler;
}

function jobFailed(resource: KubernetesObject) {
  return arrayOfRecords(resource.status?.conditions)
    .some((condition) => condition.type === "Failed" && condition.status === "True");
}

function jobComplete(resource: KubernetesObject) {
  return arrayOfRecords(resource.status?.conditions)
    .some((condition) => condition.type === "Complete" && condition.status === "True");
}

function ownedResourceFence(resource: KubernetesObject, errorCode: string) {
  const value = resource.metadata.annotations?.["wasalx.io/fencing-token"] ?? "";
  const parsed = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw new KubernetesDependencyError(false, errorCode);
  }
  return parsed;
}

function arrayOfRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}
