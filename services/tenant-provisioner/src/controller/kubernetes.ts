import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { ControllerConfig } from "./config.js";
import type { TenantWorkspace } from "../types.js";

const MAX_RESPONSE_BYTES = 1_000_000;
const MANAGED_BY = "wasalx-workspace-controller";

export type KubernetesObject = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    generation?: number;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<Record<string, unknown>>;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
};

export type LeaseRecord = {
  resourceVersion?: string;
  holderIdentity?: string;
  leaseDurationSeconds?: number;
  acquireTime?: string;
  renewTime?: string;
  leaseTransitions?: number;
};

export class KubernetesDependencyError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(
      retryable
        ? "The Kubernetes dependency is temporarily unavailable."
        : "Kubernetes rejected the workspace resource contract.",
    );
    this.name = "KubernetesDependencyError";
  }
}

export interface ControllerKubernetesClient {
  listWorkspaces(): Promise<TenantWorkspace[]>;
  getWorkspace(name: string): Promise<TenantWorkspace | null>;
  replaceWorkspaceStatus(workspace: TenantWorkspace, status: NonNullable<TenantWorkspace["status"]>): Promise<TenantWorkspace>;
  getResource(apiVersion: string, kind: string, name: string): Promise<KubernetesObject | null>;
  listOwned(apiVersion: string, kind: string, tenantId: string): Promise<KubernetesObject[]>;
  applyOwned(resource: KubernetesObject, tenantId: string): Promise<KubernetesObject>;
  deleteOwned(
    apiVersion: string,
    kind: string,
    name: string,
    tenantId: string,
    maximumFencingToken: number,
    expected?: KubernetesObject,
  ): Promise<void>;
  getLease(name: string): Promise<LeaseRecord | null>;
  replaceLease(name: string, lease: LeaseRecord): Promise<LeaseRecord>;
  ready(): Promise<boolean>;
}

export class KubernetesControllerClient implements ControllerKubernetesClient {
  private readonly workspaceCollection: string;

  constructor(
    private readonly config: ControllerConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.workspaceCollection = `/apis/platform.wasalx.io/v1alpha1/namespaces/${encodeURIComponent(config.namespace)}/tenantworkspaces`;
  }

  async listWorkspaces() {
    return this.list(`${this.workspaceCollection}?limit=500`, parseWorkspace, "WORKSPACE_LIST_INVALID");
  }

  async getWorkspace(name: string) {
    const response = await this.request(`${this.workspaceCollection}/${encodeURIComponent(name)}`, { method: "GET" }, true);
    return response === null ? null : parseWorkspace(response);
  }

  async replaceWorkspaceStatus(
    workspace: TenantWorkspace,
    status: NonNullable<TenantWorkspace["status"]>,
  ) {
    const resourceVersion = workspace.metadata.resourceVersion;
    if (!resourceVersion) throw invalid("WORKSPACE_RESOURCE_VERSION_MISSING");
    const body = {
      apiVersion: workspace.apiVersion,
      kind: workspace.kind,
      metadata: {
        name: workspace.metadata.name,
        namespace: this.config.namespace,
        resourceVersion,
      },
      status,
    };
    return parseWorkspace(await this.request(
      `${this.workspaceCollection}/${encodeURIComponent(workspace.metadata.name)}/status`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ));
  }

  async getResource(apiVersion: string, kind: string, name: string) {
    const path = resourcePath(this.config.namespace, apiVersion, kind, name);
    const response = await this.request(path, { method: "GET" }, true);
    return response === null ? null : parseObject(response, apiVersion, kind, name);
  }

  async listOwned(apiVersion: string, kind: string, tenantId: string) {
    const selector = [
      `app.kubernetes.io/managed-by=${MANAGED_BY}`,
      `wasalx.io/tenant=${tenantId}`,
      "wasalx.io/plane=tenant",
    ].join(",");
    const path = `${resourceCollectionPath(this.config.namespace, apiVersion, kind)}?limit=500&labelSelector=${encodeURIComponent(selector)}`;
    return this.list(path, (item) => {
      const root = record(item);
      const metadata = record(root?.metadata);
      if (typeof metadata?.name !== "string") throw invalid("RESOURCE_LIST_INVALID");
      const parsed = parseObject(item, apiVersion, kind, metadata.name);
      assertOwned(parsed, tenantId, this.config.namespace);
      resourceFence(parsed);
      resourceKeyHash(parsed);
      return parsed;
    }, "RESOURCE_LIST_INVALID");
  }

  private async list<T>(path: string, parse: (item: unknown) => T, errorCode: string): Promise<T[]> {
    const url = new URL(path, this.config.kubernetesApiUrl);
    const seen = new Set<string>();
    const items: T[] = [];
    for (;;) {
      const response = record(await this.request(`${url.pathname}${url.search}`, { method: "GET" }));
      if (!response || !Array.isArray(response.items)) throw invalid(errorCode);
      items.push(...response.items.map(parse));
      const continuation = record(response.metadata)?.continue;
      if (continuation === undefined || continuation === "") return items;
      if (typeof continuation !== "string" || seen.has(continuation)) throw invalid(errorCode);
      seen.add(continuation);
      url.searchParams.set("continue", continuation);
    }
  }

  async applyOwned(resource: KubernetesObject, tenantId: string) {
    assertOwned(resource, tenantId, this.config.namespace);
    const desiredFence = resourceFence(resource);
    const desiredKeyHash = resourceKeyHash(resource);
    const path = resourcePath(
      this.config.namespace,
      resource.apiVersion,
      resource.kind,
      resource.metadata.name,
    );
    const current = await this.request(path, { method: "GET" }, true);
    let desired = resource;
    if (current !== null) {
      const parsed = parseObject(current, resource.apiVersion, resource.kind, resource.metadata.name);
      assertOwned(parsed, tenantId, this.config.namespace);
      const currentFence = resourceFence(parsed);
      if (
        currentFence > desiredFence ||
        (currentFence === desiredFence && resourceKeyHash(parsed) !== desiredKeyHash)
      ) throw new KubernetesDependencyError(false, "STALE_RESOURCE_FENCE");
      if (!parsed.metadata.resourceVersion) throw invalid("RESOURCE_PRECONDITION_MISSING");
      desired = {
        ...resource,
        metadata: { ...resource.metadata, resourceVersion: parsed.metadata.resourceVersion },
      };
    }
    const applied = parseObject(
      await this.request(
        current === null
          ? `${resourceCollectionPath(this.config.namespace, resource.apiVersion, resource.kind)}?fieldManager=wasalx-workspace-controller`
          : `${path}?fieldManager=wasalx-workspace-controller&force=false`,
        current === null
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(desired),
            }
          : {
              method: "PATCH",
              headers: { "content-type": "application/apply-patch+yaml" },
              body: JSON.stringify(desired),
            },
      ),
      resource.apiVersion,
      resource.kind,
      resource.metadata.name,
    );
    assertOwned(applied, tenantId, this.config.namespace);
    requireExpectedOwners(applied, resource);
    if (resourceFence(applied) !== desiredFence || resourceKeyHash(applied) !== desiredKeyHash) {
      throw new KubernetesDependencyError(false, "RESOURCE_FENCE_INVALID");
    }
    return applied;
  }

  async deleteOwned(
    apiVersion: string,
    kind: string,
    name: string,
    tenantId: string,
    maximumFencingToken: number,
    expected?: KubernetesObject,
  ) {
    if (!Number.isSafeInteger(maximumFencingToken) || maximumFencingToken < 1) {
      throw invalid("RESOURCE_FENCE_INVALID");
    }
    const path = resourcePath(this.config.namespace, apiVersion, kind, name);
    const current = await this.request(path, { method: "GET" }, true);
    if (current === null) return;
    const resource = parseObject(current, apiVersion, kind, name);
    assertOwned(resource, tenantId, this.config.namespace);
    if (resourceFence(resource) > maximumFencingToken) {
      throw new KubernetesDependencyError(false, "STALE_RESOURCE_FENCE");
    }
    const uid = resource.metadata.uid;
    const resourceVersion = resource.metadata.resourceVersion;
    if (!uid || !resourceVersion) throw invalid("RESOURCE_PRECONDITION_MISSING");
    if (expected && (
      expected.metadata.uid !== uid ||
      expected.metadata.resourceVersion !== resourceVersion ||
      resourceFence(expected) !== resourceFence(resource) ||
      resourceKeyHash(expected) !== resourceKeyHash(resource) ||
      !isDeepStrictEqual(expected.spec, resource.spec)
    )) throw new KubernetesDependencyError(true, "RESOURCE_CHANGED");
    await this.request(path, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy: "Foreground",
        preconditions: { uid, resourceVersion },
      }),
    });
  }

  async getLease(name: string) {
    const value = await this.request(leasePath(this.config.namespace, name), { method: "GET" }, true);
    if (value === null) return null;
    const root = record(value);
    const metadata = record(root?.metadata);
    const spec = record(root?.spec);
    if (!root || root.apiVersion !== "coordination.k8s.io/v1" || root.kind !== "Lease" || typeof metadata?.resourceVersion !== "string" || !spec) {
      throw invalid("LEASE_INVALID");
    }
    return {
      resourceVersion: metadata.resourceVersion,
      ...(typeof spec.holderIdentity === "string" ? { holderIdentity: spec.holderIdentity } : {}),
      ...(Number.isInteger(spec.leaseDurationSeconds) ? { leaseDurationSeconds: Number(spec.leaseDurationSeconds) } : {}),
      ...(typeof spec.acquireTime === "string" ? { acquireTime: spec.acquireTime } : {}),
      ...(typeof spec.renewTime === "string" ? { renewTime: spec.renewTime } : {}),
      ...(Number.isInteger(spec.leaseTransitions) ? { leaseTransitions: Number(spec.leaseTransitions) } : {}),
    };
  }

  async replaceLease(name: string, lease: LeaseRecord) {
    const body = {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: {
        name,
        namespace: this.config.namespace,
        ...(lease.resourceVersion ? { resourceVersion: lease.resourceVersion } : {}),
        labels: {
          "app.kubernetes.io/managed-by": MANAGED_BY,
          "app.kubernetes.io/part-of": "wasalx",
        },
      },
      spec: {
        holderIdentity: lease.holderIdentity,
        leaseDurationSeconds: lease.leaseDurationSeconds,
        acquireTime: lease.acquireTime,
        renewTime: lease.renewTime,
        leaseTransitions: lease.leaseTransitions,
      },
    };
    const collection = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.config.namespace)}/leases`;
    const response = lease.resourceVersion
      ? await this.request(`${collection}/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      : await this.request(collection, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
    const root = record(response);
    const metadata = record(root?.metadata);
    const spec = record(root?.spec);
    if (!metadata || !spec || typeof metadata.resourceVersion !== "string") throw invalid("LEASE_INVALID");
    return {
      resourceVersion: metadata.resourceVersion,
      holderIdentity: String(spec.holderIdentity ?? ""),
      leaseDurationSeconds: Number(spec.leaseDurationSeconds),
      acquireTime: String(spec.acquireTime ?? ""),
      renewTime: String(spec.renewTime ?? ""),
      leaseTransitions: Number(spec.leaseTransitions ?? 0),
    };
  }

  async ready() {
    try {
      await this.request(`${this.workspaceCollection}?limit=1`, { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  private async request(path: string, init: RequestInit, allowNotFound = false): Promise<unknown | null> {
    let token: string;
    try {
      token = (await readFile(this.config.kubernetesTokenFile, "utf8")).trim();
    } catch {
      throw unavailable("KUBERNETES_TOKEN_UNAVAILABLE");
    }
    if (token.length < 16 || token.length > 16_384 || /[\p{Cc}\p{Cf}]/u.test(token)) {
      throw unavailable("KUBERNETES_TOKEN_INVALID");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.config.kubernetesApiUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...init.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch {
      throw unavailable("KUBERNETES_UNREACHABLE");
    }
    if (allowNotFound && response.status === 404) return null;
    const body = await boundedJson(response);
    if (!response.ok) {
      if (response.status === 409) throw new KubernetesDependencyError(true, "KUBERNETES_CONFLICT");
      if ([401, 403].includes(response.status)) throw new KubernetesDependencyError(false, "KUBERNETES_FORBIDDEN");
      if ([404, 405, 415, 422].includes(response.status)) throw new KubernetesDependencyError(false, `KUBERNETES_CONTRACT_${response.status}`);
      throw unavailable(`KUBERNETES_HTTP_${response.status}`);
    }
    return body;
  }
}

const RESOURCE_ENDPOINTS: Record<string, { group: string; version: string; plural: string }> = {
  "v1/Service": { group: "", version: "v1", plural: "services" },
  "v1/ConfigMap": { group: "", version: "v1", plural: "configmaps" },
  "v1/PersistentVolumeClaim": { group: "", version: "v1", plural: "persistentvolumeclaims" },
  "apps/v1/Deployment": { group: "apps", version: "v1", plural: "deployments" },
  "batch/v1/Job": { group: "batch", version: "v1", plural: "jobs" },
  "batch/v1/CronJob": { group: "batch", version: "v1", plural: "cronjobs" },
  "networking.k8s.io/v1/Ingress": { group: "networking.k8s.io", version: "v1", plural: "ingresses" },
  "networking.k8s.io/v1/NetworkPolicy": { group: "networking.k8s.io", version: "v1", plural: "networkpolicies" },
  "policy/v1/PodDisruptionBudget": { group: "policy", version: "v1", plural: "poddisruptionbudgets" },
  "external-secrets.io/v1beta1/ExternalSecret": { group: "external-secrets.io", version: "v1beta1", plural: "externalsecrets" },
};

function resourcePath(namespace: string, apiVersion: string, kind: string, name: string) {
  return `${resourceCollectionPath(namespace, apiVersion, kind)}/${encodeURIComponent(name)}`;
}

function resourceCollectionPath(namespace: string, apiVersion: string, kind: string) {
  const endpoint = RESOURCE_ENDPOINTS[`${apiVersion}/${kind}`];
  if (!endpoint) throw invalid("RESOURCE_KIND_DENIED");
  const prefix = endpoint.group
    ? `/apis/${endpoint.group}/${endpoint.version}`
    : `/api/${endpoint.version}`;
  return `${prefix}/namespaces/${encodeURIComponent(namespace)}/${endpoint.plural}`;
}

function leasePath(namespace: string, name: string) {
  return `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/leases/${encodeURIComponent(name)}`;
}

function parseObject(value: unknown, apiVersion: string, kind: string, name: string) {
  const root = record(value);
  const metadata = record(root?.metadata);
  if (!root || root.apiVersion !== apiVersion || root.kind !== kind || metadata?.name !== name) {
    throw invalid("RESOURCE_RESPONSE_INVALID");
  }
  return value as KubernetesObject;
}

function parseWorkspace(value: unknown): TenantWorkspace {
  const root = record(value);
  const metadata = record(root?.metadata);
  const spec = record(root?.spec);
  if (
    !root ||
    root.apiVersion !== "platform.wasalx.io/v1alpha1" ||
    root.kind !== "TenantWorkspace" ||
    typeof metadata?.name !== "string" ||
    typeof metadata.uid !== "string" ||
    typeof metadata.resourceVersion !== "string" ||
    !spec
  ) throw invalid("WORKSPACE_INVALID");
  return value as TenantWorkspace;
}

function assertOwned(resource: KubernetesObject, tenantId: string, namespace: string) {
  if (
    resource.metadata.namespace !== namespace ||
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] !== MANAGED_BY ||
    resource.metadata.labels?.["wasalx.io/tenant"] !== tenantId ||
    resource.metadata.labels?.["wasalx.io/plane"] !== "tenant" ||
    resource.metadata.annotations?.["wasalx.io/workspace"] !== `tenant-${tenantId}`
  ) throw new KubernetesDependencyError(false, "RESOURCE_OWNERSHIP_DENIED");
}

function requireExpectedOwners(resource: KubernetesObject, expected: KubernetesObject) {
  const expectedOwners = expected.metadata.ownerReferences ?? [];
  if (expectedOwners.some((owner) => !resource.metadata.ownerReferences?.some((candidate) =>
    candidate.apiVersion === owner.apiVersion &&
    candidate.kind === owner.kind &&
    candidate.name === owner.name &&
    candidate.uid === owner.uid &&
    candidate.controller === owner.controller
  ))) throw new KubernetesDependencyError(false, "RESOURCE_OWNERSHIP_DENIED");
}

function resourceFence(resource: KubernetesObject) {
  const value = resource.metadata.annotations?.["wasalx.io/fencing-token"] ?? "";
  const parsed = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw invalid("RESOURCE_FENCE_INVALID");
  }
  return parsed;
}

function resourceKeyHash(resource: KubernetesObject) {
  const value = resource.metadata.annotations?.["wasalx.io/idempotency-key-hash"] ?? "";
  if (!/^[0-9a-f]{64}$/u.test(value)) throw invalid("RESOURCE_IDEMPOTENCY_INVALID");
  return value;
}

async function boundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw unavailable("KUBERNETES_RESPONSE_TOO_LARGE");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw unavailable("KUBERNETES_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return {};
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw unavailable("KUBERNETES_RESPONSE_INVALID");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unavailable(code: string) {
  return new KubernetesDependencyError(true, code);
}

function invalid(code: string) {
  return new KubernetesDependencyError(false, code);
}
