import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createFakeWorkspaceProviderHandler } from "../tools/fake-workspace-provider.mjs";
import { HttpWorkspaceProvider } from "../services/tenant-provisioner/dist/controller/provider.js";
import { KubernetesControllerClient } from "../services/tenant-provisioner/dist/controller/kubernetes.js";
import { loadControllerConfig } from "../services/tenant-provisioner/dist/controller/config.js";
import { LeaseLeaderElector } from "../services/tenant-provisioner/dist/controller/leader.js";
import {
  ControllerLeadershipLostError,
  WorkspaceControllerReconciler,
} from "../services/tenant-provisioner/dist/controller/reconciler.js";
import { buildActiveResources, buildConfigurationJob, buildExternalSecret } from "../services/tenant-provisioner/dist/controller/resources.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const zammadInstanceId = "50000000-0000-4000-8000-000000000001";
const compact = tenantId.replaceAll("-", "");
const packageSha = "a".repeat(64);
const imageSha = "b".repeat(64);
const configuratorSha = "c".repeat(64);

function controllerConfig(overrides = {}) {
  return {
    port: 8091,
    kubernetesApiUrl: new URL("https://kubernetes.default.svc/"),
    kubernetesTokenFile: "/kube-token",
    namespace: "wasalx-tenants",
    identity: "wasalx-workspace-controller/v1",
    instanceId: "controller-a",
    leaseName: "wasalx-workspace-controller",
    leaseDurationSeconds: 30,
    pollIntervalMs: 5_000,
    requestTimeoutMs: 10_000,
    providerUrl: new URL("https://workspace-provider.platform.svc.cluster.local/"),
    controlPlaneUrl: new URL("https://control-api.platform.svc.cluster.local/"),
    portalUrl: new URL("https://app.example.test/"),
    providerTokenFile: "/provider-token",
    providerTimeoutMs: 10_000,
    externalSecretStoreName: "wasalx-tenant-secrets",
    externalSecretStoreKind: "ClusterSecretStore",
    baseDomain: "support.example.test",
    ingressClassName: "nginx",
    ingressNamespace: "ingress-system",
    clusterIssuer: "letsencrypt-production",
    storageClassName: "encrypted-rwo",
    secureRedis: true,
    profiles: {
      small: { cpu: "1", memory: "2Gi", storage: "20Gi", replicas: 1 },
      medium: { cpu: "2", memory: "4Gi", storage: "50Gi", replicas: 2 },
      large: { cpu: "4", memory: "8Gi", storage: "100Gi", replicas: 3 },
    },
    backupSchedule: "0 3 * * *",
    allowedEgress: [{ cidr: "10.0.0.0/8", ports: [443, 5432, 9200] }],
    ...overrides,
  };
}

function workspace(step = "identity", completedSteps = []) {
  return {
    apiVersion: "platform.wasalx.io/v1alpha1",
    kind: "TenantWorkspace",
    metadata: {
      name: `tenant-${tenantId}`,
      namespace: "wasalx-tenants",
      uid: "40000000-0000-4000-8000-000000000001",
      generation: 5,
      resourceVersion: "40",
      labels: { "wasalx.io/tenant": tenantId },
    },
    spec: {
      tenantId,
      displayName: "Northstar",
      slug: "northstar",
      region: "sa-riyadh-1",
      resourceProfile: "small",
      retentionDays: 90,
      owner: { oidcSubject: "owner-1", email: "owner@example.test", displayName: "Owner" },
      request: {
        operationId,
        action: "PROVISION",
        desiredStep: step,
        fencingToken: 9,
        idempotencyKey: `provision:${tenantId}:${operationId}:${step}`,
        completedSteps,
      },
      database: {
        isolation: "DedicatedDatabaseAndRole",
        databaseName: `zammad_${compact}`,
        roleName: `zammad_${compact}`,
        secretReference: `secret://tenants/${tenantId}/zammad/database`,
      },
      search: {
        isolation: "DedicatedNamespaceAndCredential",
        namespace: `wasalx_${compact}`,
        secretReference: `secret://tenants/${tenantId}/zammad/search`,
      },
      storage: {
        isolation: "DedicatedPrefixAndCredential",
        prefix: `tenants/${tenantId}/`,
        secretReference: `secret://tenants/${tenantId}/zammad/storage`,
      },
      secrets: {
        serviceSecretReference: `secret://tenants/${tenantId}/zammad/service`,
        privacySecretReference: `secret://tenants/${tenantId}/zammad/privacy`,
      },
      zammad: {
        instanceId: zammadInstanceId,
        version: "7.1.3",
        image: `ghcr.io/zammad/zammad@sha256:${imageSha}`,
        configuratorImage: `registry.example.test/wasalx/configurator@sha256:${configuratorSha}`,
        nginxImage: `registry.example.test/nginx@sha256:${"d".repeat(64)}`,
        redisImage: `registry.example.test/redis@sha256:${"e".repeat(64)}`,
        memcachedImage: `registry.example.test/memcached@sha256:${"f".repeat(64)}`,
        hostname: "northstar.support.example.test",
        packageVersion: "0.3.0",
        packageSha256: packageSha,
      },
      oidc: {
        issuer: "https://identity.example.test/realms/wasalx",
        clientId: `wasalx-${compact}`,
        secretReference: `secret://tenants/${tenantId}/zammad/oidc`,
        disablePasswordLogin: true,
      },
      defaults: { initialGroup: "Operations", backupPolicy: "daily-encrypted", retentionDays: 90 },
      desiredState: "Active",
    },
    status: { conditions: [], outputs: {} },
  };
}

test("controller configuration fails closed without private provider dependencies", () => {
  assert.throws(() => loadControllerConfig({ NODE_ENV: "production" }), /WORKSPACE_PROVIDER_URL/);
  const base = {
    NODE_ENV: "production",
    KUBERNETES_API_URL: "https://kubernetes.default.svc",
    WORKSPACE_PROVIDER_URL: "https://workspace-provider.platform.svc.cluster.local",
    WASALX_CONTROL_URL: "https://control-api.platform.svc.cluster.local",
    WASALX_PORTAL_URL: "https://app.example.test",
    PROVISIONING_RECONCILER_IDENTITY: "wasalx-workspace-controller/v1",
    EXTERNAL_SECRET_STORE_NAME: "wasalx-tenant-secrets",
    PROVISIONING_WORKSPACE_BASE_DOMAIN: "support.example.test",
    ZAMMAD_INGRESS_CLASS_NAME: "nginx",
    ZAMMAD_INGRESS_NAMESPACE: "ingress-system",
    ZAMMAD_CLUSTER_ISSUER: "letsencrypt-production",
    ZAMMAD_STORAGE_CLASS_NAME: "encrypted-rwo",
  };
  assert.throws(() => loadControllerConfig({ ...base, WORKSPACE_PROVIDER_URL: "https://provider.example.com" }), /private/);
  assert.throws(() => loadControllerConfig({ ...base, WASALX_CONTROL_URL: "https://control.example.com" }), /private/);
  assert.throws(() => loadControllerConfig({ ...base, WASALX_PORTAL_URL: "http://app.example.test" }), /HTTPS origin/);
  assert.throws(() => loadControllerConfig({ ...base, WASALX_PORTAL_URL: "https://app.example.test/private" }), /HTTPS origin/);
  assert.throws(() => loadControllerConfig({ ...base, EXTERNAL_SECRET_STORE_KIND: "TypoStore" }), /invalid/);
  assert.throws(
    () => loadControllerConfig({ ...base, ZAMMAD_ALLOWED_EGRESS_JSON: JSON.stringify([{ cidr: "0.0.0.0/0", ports: [443] }]) }),
    /invalid/,
  );
  assert.throws(
    () => loadControllerConfig({ ...base, CONTROLLER_LEASE_DURATION_SECONDS: "30" }),
    /safe failover margin/,
  );
  assert.equal(loadControllerConfig(base).ingressNamespace, "ingress-system");
  assert.deepEqual(loadControllerConfig(base).backupEncryption, { mode: "SSE_KMS" });
  const ageRecipient = `age1${"q".repeat(58)}`;
  assert.deepEqual(loadControllerConfig({ ...base, ZAMMAD_BACKUP_ENCRYPTION_MODE: "CLIENT_ENVELOPE", ZAMMAD_BACKUP_AGE_RECIPIENT: ageRecipient }).backupEncryption,
    { mode: "CLIENT_ENVELOPE", ageRecipient });
  for (const invalid of ["AGE-SECRET-KEY-private", "ssh-ed25519 key", `${ageRecipient}\n`, ""]) {
    assert.throws(() => loadControllerConfig({ ...base, ZAMMAD_BACKUP_ENCRYPTION_MODE: "CLIENT_ENVELOPE", ZAMMAD_BACKUP_AGE_RECIPIENT: invalid }), /backup encryption/);
  }
});

test("client-encrypted tenant backups omit KMS projections and retain scoped storage credentials", () => {
  const ageRecipient = `age1${"q".repeat(58)}`;
  const config = controllerConfig({ backupEncryption: { mode: "CLIENT_ENVELOPE", ageRecipient } });
  const ws = workspace();
  const external = buildExternalSecret(ws, config);
  assert.equal(external.spec.data.some((entry) => entry.secretKey === "BACKUP_S3_KMS_KEY_REFERENCE"), false);
  assert.ok(external.spec.data.some((entry) => entry.secretKey === "BACKUP_S3_SECRET_ACCESS_KEY"));
  const resources = buildActiveResources(ws, config);
  const env = resources.backup.spec.jobTemplate.spec.template.spec.containers[0].env;
  assert.equal(env.find((entry) => entry.name === "BACKUP_AGE_RECIPIENT").value, ageRecipient);
  assert.equal(env.find((entry) => entry.name === "BACKUP_ENCRYPTION_MODE").value, "CLIENT_ENVELOPE");
  assert.equal(env.some((entry) => entry.name === "BACKUP_S3_KMS_KEY_REFERENCE"), false);
  assert.equal(env.some((entry) => entry.name === "ZAMMAD_SERVICE_TOKEN"), false);
  assert.ok(buildExternalSecret(ws, controllerConfig()).spec.data.some((entry) => entry.secretKey === "BACKUP_S3_KMS_KEY_REFERENCE"));
});

test("resource builder emits isolated runtime resources and only secret-manager references", () => {
  const ws = workspace("zammad", ["identity", "database", "search", "storage", "secrets"]);
  const externalSecret = buildExternalSecret(ws, controllerConfig());
  const resources = buildActiveResources(ws, controllerConfig());
  const backupConfigurator = resources.backup.spec.jobTemplate.spec.template.spec.containers[0];
  const job = buildConfigurationJob(workspace("package"), controllerConfig(), "package");
  const oidcJob = buildConfigurationJob(workspace("oidc"), controllerConfig(), "oidc");
  const defaultsJob = buildConfigurationJob(workspace("defaults"), controllerConfig(), "defaults");
  for (const container of [backupConfigurator, ...[job, oidcJob, defaultsJob].map((entry) => entry.spec.template.spec.containers[0])]) {
    assert.deepEqual(container.resources, {
      requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" },
    });
  }
  const rendered = JSON.stringify({ externalSecret, resources, job, oidcJob });
  for (const value of ["Deployment", "Service", "Ingress", "PersistentVolumeClaim", "PodDisruptionBudget", "NetworkPolicy", "CronJob", "ExternalSecret"]) {
    assert.match(rendered, new RegExp(value));
  }
  assert.equal(externalSecret.spec.target.creationPolicy, "Owner");
  assert.equal(externalSecret.spec.target.deletionPolicy, "Delete");
  assert.equal(externalSecret.spec.data.some((entry) => entry.secretKey === "OIDC_CLIENT_SECRET"), false);
  assert.ok(externalSecret.spec.data.some((entry) => entry.secretKey === "WASALX_SERVICE_JWT_SECRET" && entry.remoteRef.property === "jwt_secret"));
  assert.ok(externalSecret.spec.data.some((entry) => entry.secretKey === "WASALX_ZAMMAD_INSTANCE_ID" && entry.remoteRef.property === "instance_id"));
  for (const [secretKey, property] of [
    ["REDIS_URL", "redis_url"],
    ["REDIS_PASSWORD", "redis_password"],
    ["REDIS_ACL", "redis_acl"],
    ["REDIS_TLS_CA", "redis_ca"],
    ["REDIS_TLS_CERT", "redis_cert"],
    ["REDIS_TLS_KEY", "redis_key"],
  ]) {
    assert.ok(externalSecret.spec.data.some((entry) => entry.secretKey === secretKey && entry.remoteRef.property === property));
  }
  assert.equal(externalSecret.spec.data.some((entry) => entry.secretKey === "WASALX_SERVICE_TOKEN"), false);
  const packageConfigurator = job.spec.template.spec.containers[0];
  const oidcConfigurator = oidcJob.spec.template.spec.containers[0];
  const nginx = resources.deployments.find((entry) => entry.spec.template.spec.containers[0].name === "nginx");
  for (const deployment of resources.deployments) {
    for (const container of deployment.spec.template.spec.containers) {
      assert.deepEqual((container.env ?? []).filter(entry => entry.name === "RAILS_SERVE_STATIC_FILES"),
        container.name === "zammad-railsserver" ? [{ name: "RAILS_SERVE_STATIC_FILES", value: "true" }] : []);
    }
  }
  const nginxText = resources.nginxConfig.data["nginx.conf"];
  for (const [directive, path] of Object.entries({
    pid: "/tmp/nginx.pid", client_body_temp_path: "/tmp/client_temp", proxy_temp_path: "/tmp/proxy_temp",
    fastcgi_temp_path: "/tmp/fastcgi_temp", uwsgi_temp_path: "/tmp/uwsgi_temp", scgi_temp_path: "/tmp/scgi_temp",
    access_log: "/dev/stdout", error_log: "/dev/stderr warn",
  })) assert.ok(nginxText.includes(`${directive} ${path};`));
  assert.equal(nginx.spec.template.metadata.annotations["wasalx.io/nginx-config-sha256"], createHash("sha256").update(nginxText).digest("hex"));
  assert.equal(nginx.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.ok(nginx.spec.template.spec.containers[0].volumeMounts.some(mount => mount.name === "tmp" && mount.mountPath === "/tmp"));
  const otherWorkspace = structuredClone(ws);
  otherWorkspace.spec.tenantId = "10000000-0000-4000-8000-000000000002";
  const otherNginx = buildActiveResources(otherWorkspace, controllerConfig()).deployments.find(entry => entry.spec.template.spec.containers[0].name === "nginx");
  assert.notEqual(otherNginx.spec.template.metadata.annotations["wasalx.io/nginx-config-sha256"], nginx.spec.template.metadata.annotations["wasalx.io/nginx-config-sha256"]);
  assert.match(nginxText, /location \^~ \/api\/v1\/ /u);
  assert.match(nginxText, /location = \/auth\/openid_connect\/backchannel_logout /u);
  assert.match(nginxText, /location \/ \{ return 404; \}/u);
  assert.doesNotMatch(nginxText, /wasalx_root_redirect|location \/cable|location \/ws/u);
  assert.match(nginxText, /proxy_set_header Host \$http_host/u);
  assert.equal(nginx.spec.template.spec.containers[0].readinessProbe.httpGet.path, "/api/v1/wasalx/health");
  assert.equal(packageConfigurator.env.some((entry) => entry.name === "OIDC_CLIENT_SECRET"), false);
  assert.equal(oidcConfigurator.env.some((entry) => entry.name === "OIDC_CLIENT_SECRET"), false);
  assert.ok(packageConfigurator.env.some((entry) => entry.name === "ZAMMAD_SERVICE_TOKEN" && entry.valueFrom));
  assert.ok(oidcConfigurator.env.some((entry) => entry.name === "ZAMMAD_SERVICE_TOKEN" && entry.valueFrom));
  assert.equal(packageConfigurator.env.some((entry) => entry.name === "DATABASE_URL"), false);
  assert.equal(oidcConfigurator.env.some((entry) => entry.name.startsWith("BACKUP_S3_")), false);
  assert.ok(backupConfigurator.env.some((entry) => entry.name === "DATABASE_URL" && entry.valueFrom));
  assert.ok(backupConfigurator.env.some((entry) => entry.name === "BACKUP_S3_SECRET_ACCESS_KEY" && entry.valueFrom));
  assert.equal(backupConfigurator.env.some((entry) => entry.name === "ZAMMAD_SERVICE_TOKEN"), false);
  for (const deployment of resources.deployments) {
    assert.equal(deployment.spec.template.spec.containers[0].env?.some((entry) => entry.name === "OIDC_CLIENT_SECRET") ?? false, false);
  }
  const railsserver = resources.deployments.find((entry) => entry.metadata.name.endsWith("-railsserver"));
  const runtimeEnvironment = railsserver.spec.template.spec.containers[0].env;
  assert.ok(runtimeEnvironment.some((entry) => entry.name === "WASALX_SERVICE_JWT_SECRET" && entry.valueFrom?.secretKeyRef?.key === "WASALX_SERVICE_JWT_SECRET"));
  assert.ok(runtimeEnvironment.some((entry) => entry.name === "WASALX_ZAMMAD_INSTANCE_ID" && entry.valueFrom?.secretKeyRef?.key === "WASALX_ZAMMAD_INSTANCE_ID"));
  assert.ok(runtimeEnvironment.some((entry) => entry.name === "WASALX_TENANT_ID" && entry.value === tenantId));
  assert.ok(runtimeEnvironment.some((entry) => entry.name === "WASALX_CONTROL_URL" && entry.value === "https://control-api.platform.svc.cluster.local/"));
  assert.ok(runtimeEnvironment.some((entry) => entry.name === "WASALX_PORTAL_URL" && entry.value === "https://app.example.test/"));
  assert.equal(runtimeEnvironment.some((entry) => entry.name === "WASALX_SERVICE_TOKEN"), false);
  assert.doesNotMatch(rendered, /WASALX_SERVICE_TOKEN/);
  assert.match(rendered, /tenants\/10000000-0000-4000-8000-000000000001\/zammad\/database/);
  assert.match(rendered, new RegExp(`@sha256:${imageSha}`));
  assert.match(rendered, new RegExp(`@sha256:${configuratorSha}`));
  assert.doesNotMatch(rendered, /raw-password|secret-access-value|"(?:password|token)":"/i);
  const concreteResources = Object.values(resources).flatMap((resource) => Array.isArray(resource) ? resource : [resource]);
  for (const resource of concreteResources) {
    assert.equal(resource.metadata.labels["app.kubernetes.io/managed-by"], "wasalx-workspace-controller");
    assert.equal(resource.metadata.labels["wasalx.io/tenant"], tenantId);
    assert.equal(resource.metadata.annotations["wasalx.io/fencing-token"], "9");
    assert.match(resource.metadata.annotations["wasalx.io/idempotency-key-hash"], /^[0-9a-f]{64}$/u);
    if (resource.kind === "PersistentVolumeClaim") {
      assert.equal(resource.metadata.ownerReferences, undefined);
      assert.equal(resource.metadata.annotations["wasalx.io/retention-protected"], "true");
    } else {
      assert.equal(resource.metadata.ownerReferences[0].uid, "40000000-0000-4000-8000-000000000001");
    }
  }
  assert.equal(resources.backup.spec.jobTemplate.metadata.labels["wasalx.io/tenant"], tenantId);
  assert.equal(resources.backup.spec.jobTemplate.metadata.annotations["wasalx.io/fencing-token"], "9");
  assert.match(resources.backup.spec.jobTemplate.metadata.annotations["wasalx.io/idempotency-key-hash"], /^[0-9a-f]{64}$/u);
  assert.equal(resources.redisPvc.spec.storageClassName, "encrypted-rwo");
  const redis = resources.deployments.find((entry) => entry.metadata.name.endsWith("-redis"));
  const scheduler = resources.deployments.find((entry) => entry.metadata.name.endsWith("-scheduler"));
  const websocket = resources.deployments.find((entry) => entry.metadata.name.endsWith("-websocket"));
  assert.equal(redis.spec.strategy.type, "Recreate");
  assert.deepEqual(redis.spec.template.spec.containers[0].command, ["redis-server"]);
  assert.deepEqual(railsserver.spec.template.spec.containers[0].command, ["/usr/local/bin/wasalx-zammad-entrypoint", "zammad-railsserver"]);
  assert.equal(railsserver.spec.template.metadata.labels["app.kubernetes.io/managed-by"], "wasalx-workspace-controller");
  assert.ok(resources.networkPolicy.spec.egress.some(rule => rule.ports?.some(port => port.port === 3001)
    && rule.to?.some(peer => peer.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "wasalx-api")));
  assert.ok(resources.networkPolicy.spec.ingress.some(rule => rule.ports?.some(port => port.port === 8080)
    && rule.from?.some(peer => peer.podSelector?.matchExpressions?.some(expression =>
      expression.key === "app.kubernetes.io/name" && expression.values.includes("wasalx-api") && expression.values.includes("wasalx-worker")))));
  assert.ok(redis.spec.template.spec.containers[0].args.includes("--tls-port"));
  assert.ok(redis.spec.template.spec.containers[0].args.includes("--aclfile"));
  assert.equal(redis.spec.template.spec.containers[0].env[0].name, "REDISCLI_AUTH");
  assert.equal(scheduler.spec.strategy.type, "Recreate");
  assert.equal(websocket.spec.strategy.type, "Recreate");
  assert.equal(redis.spec.template.spec.volumes.some((entry) => entry.persistentVolumeClaim?.claimName === resources.redisPvc.metadata.name), true);
  assert.ok(redis.spec.template.spec.volumes.some((entry) => entry.name === "redis-server-security"));
  assert.ok(runtimeEnvironment.some((entry) => entry.name === "REDIS_URL" && entry.valueFrom?.secretKeyRef?.key === "REDIS_URL"));
  assert.ok(runtimeEnvironment.some((entry) => entry.name === "SSL_CERT_FILE"));
  const initPod = resources.initJob.spec.template.spec;
  const rootInitializer = initPod.initContainers[0];
  const installContainer = initPod.containers[0];
  assert.deepEqual(rootInitializer.command.slice(0, 2), ["bash", "-lc"]);
  assert.match(rootInitializer.command[2], /ca-certificates\.crt[\s\S]*wasalx-zammad-entrypoint zammad-init/u);
  assert.equal(rootInitializer.resources.requests.cpu, "500m");
  assert.deepEqual(rootInitializer.env.filter(entry => entry.name === "RAILS_CHECK_PENDING_MIGRATIONS"),
    [{ name: "RAILS_CHECK_PENDING_MIGRATIONS", value: "false" }]);
  assert.deepEqual(installContainer.env.filter(entry => entry.name === "RAILS_CHECK_PENDING_MIGRATIONS"),
    [{ name: "RAILS_CHECK_PENDING_MIGRATIONS", value: "true" }]);
  assert.deepEqual(runtimeEnvironment.filter(entry => entry.name === "RAILS_CHECK_PENDING_MIGRATIONS"),
    [{ name: "RAILS_CHECK_PENDING_MIGRATIONS", value: "true" }]);
  assert.equal(resources.initJob.spec.backoffLimit, 0);
  assert.equal(runtimeEnvironment.find(entry => entry.name === "TMP").value, "/opt/zammad/tmp/wasalx");
  const previousInitSuffix = createHash("sha256").update(JSON.stringify([
    rootInitializer.image, ws.spec.zammad.version, ws.spec.zammad.packageVersion,
    ws.spec.zammad.packageSha256, controllerConfig().secureRedis,
  ])).digest("hex").slice(0, 10);
  assert.equal(resources.initJob.metadata.name.endsWith(previousInitSuffix), false,
    "the corrected initializer must not reuse an immutable failed Job");
  for (const field of ["oidcSubject", "email", "displayName"]) {
    const changed = structuredClone(ws);
    changed.spec.owner[field] += "-changed";
    assert.notEqual(buildActiveResources(changed, controllerConfig()).initJob.metadata.name,
      resources.initJob.metadata.name, `owner ${field} changes require a new immutable Job`);
  }
  assert.equal(resources.initJob.spec.template.spec.containers[0].resources.requests.cpu, "500m");
  assert.doesNotMatch(rootInitializer.command[2], /wasalx-package-install|wasalx-runtime-bootstrap/u);
  assert.match(installContainer.command[2], /^wasalx-package-install && wasalx-runtime-bootstrap$/u);
  assert.ok(installContainer.env.some((entry) => entry.name === "WASALX_PACKAGE_VERSION" && entry.value === "0.3.0"));
  assert.ok(installContainer.env.some((entry) => entry.name === "WASALX_PACKAGE_SHA256" && entry.value === packageSha));
  assert.ok(installContainer.env.some((entry) => entry.name === "ZAMMAD_SERVICE_TOKEN" && entry.valueFrom?.secretKeyRef?.key === "ZAMMAD_SERVICE_TOKEN"));
  assert.ok(installContainer.env.some((entry) => entry.name === "ZAMMAD_PRIVACY_TOKEN" && entry.valueFrom?.secretKeyRef?.key === "ZAMMAD_PRIVACY_TOKEN"));
  assert.ok(installContainer.env.some((entry) => entry.name === "WASALX_ZAMMAD_BOOTSTRAP_PASSWORD" && entry.valueFrom?.secretKeyRef?.key === "ZAMMAD_BOOTSTRAP_PASSWORD"));
  assert.ok(installContainer.env.some((entry) => entry.name === "WASALX_ZAMMAD_BOOTSTRAP_EMAIL" && entry.value === "owner@example.test"));
  assert.ok(installContainer.env.some((entry) => entry.name === "WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT" && entry.value === "owner-1"));
  assert.equal(runtimeEnvironment.some((entry) => entry.name === "ZAMMAD_PRIVACY_TOKEN" || entry.name === "WASALX_ZAMMAD_BOOTSTRAP_PASSWORD"), false);
  assert.equal(resources.initJob.spec.ttlSecondsAfterFinished, undefined);
  assert.equal(rootInitializer.securityContext.runAsUser, 0);
  assert.equal(rootInitializer.securityContext.allowPrivilegeEscalation, false);
  assert.equal(installContainer.securityContext.runAsNonRoot, true);
  for (const deployment of resources.deployments) {
    assert.equal(deployment.spec.template.spec.securityContext.runAsUser, 1000);
    assert.equal(deployment.spec.template.spec.securityContext.runAsNonRoot, true);
    assert.equal(deployment.spec.template.spec.containers[0].securityContext.runAsNonRoot, true);
  }
  assert.match(rendered, /ingress-system/);
  assert.match(rendered, /POSTGRESQL_DB_CREATE/);
});

test("controller makes Redis and Memcached ready before init, then starts non-root runtimes", async () => {
  const ws = withPrior(workspace("zammad", ["identity", "database", "search", "storage", "secrets"]));
  const calls = [];
  const kubernetes = fakeKubernetes({ workspace: ws });
  const originalApply = kubernetes.applyOwned;
  kubernetes.applyOwned = async (resource, actualTenantId) => {
    calls.push(`${resource.kind}:${resource.metadata.name}`);
    return originalApply(resource, actualTenantId);
  };
  const provider = {
    ready: async () => true,
    execute: async () => ({
      zammad_base_url: "https://northstar.support.example.test",
      deployment_name: `zammad-${compact}`,
    }),
  };
  const result = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(ws);
  assert.equal(result.status.conditions.find((entry) => entry.type === "ZammadReady").status, "True");
  assert.equal(result.status.outputs.zammad.runtime_image, ws.spec.zammad.image);
  assert.equal(result.status.outputs.zammad.package_version, ws.spec.zammad.packageVersion);
  assert.equal(result.status.outputs.zammad.package_sha256, ws.spec.zammad.packageSha256);
  const redisIndex = calls.findIndex((entry) => entry === `Deployment:zammad-${compact}-redis`);
  const memcachedIndex = calls.findIndex((entry) => entry === `Deployment:zammad-${compact}-memcached`);
  const initIndex = calls.findIndex((entry) => entry.startsWith(`Job:zammad-${compact}-init-`));
  const railsIndex = calls.findIndex((entry) => entry === `Deployment:zammad-${compact}-railsserver`);
  assert.ok(redisIndex >= 0 && memcachedIndex >= 0 && initIndex > redisIndex && initIndex > memcachedIndex);
  assert.ok(railsIndex > initIndex);
  assert.equal(calls.some((entry) => entry.startsWith("Ingress:")), false);
});

test("a currently published healthy workspace converges without withdrawing ingress", async () => {
  const completed = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults"];
  const ws = withPrior(workspace("health", completed));
  ws.status.outputs.health = { healthy: true, isolation_verified: true, zammad_base_url: "https://northstar.support.example.test", checked_at: new Date().toISOString() };
  ws.status.conditions.push({ type: "Healthy", status: "True", observedGeneration: ws.metadata.generation });
  ws.status.observedGeneration = ws.metadata.generation;
  ws.status.observedFencingToken = ws.spec.request.fencingToken;
  ws.status.lastAppliedIdempotencyKey = ws.spec.request.idempotencyKey;
  ws.status.reconciler = "wasalx-workspace-controller/v1";
  ws.status.conditions.find((entry) => entry.type === "Healthy").observedGeneration = ws.metadata.generation;
  let ingress = buildActiveResources(ws, controllerConfig()).ingress;
  const deletes = [];
  const kubernetes = fakeKubernetes({ workspace: ws });
  const apply = kubernetes.applyOwned;
  kubernetes.applyOwned = async (resource, actualTenantId) => {
    const result = await apply(resource, actualTenantId);
    if (resource.kind === "Ingress") ingress = result;
    return result;
  };
  kubernetes.getResource = async (_apiVersion, kind) => kind === "Ingress" ? ingress : null;
  kubernetes.deleteOwned = async (_apiVersion, kind) => { deletes.push(kind); };
  await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, {
    ready: async () => true,
    execute: async () => ({
      healthy: true,
      isolation_verified: true,
      zammad_base_url: "https://northstar.support.example.test",
      checked_at: new Date().toISOString(),
    }),
  }).reconcile(ws);
  assert.deepEqual(deletes, []);
});

test("a stale fresh-health publisher cannot compensate a successor ingress", async () => {
  const completed = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults"];
  let current = withPrior(workspace("health", completed));
  let ingress = null;
  let ingressDeleteAttempts = 0;
  const kubernetes = fakeKubernetes({ workspace: current });
  kubernetes.getWorkspace = async () => structuredClone(current);
  kubernetes.replaceWorkspaceStatus = async (ws, status) => {
    current = { ...structuredClone(ws), metadata: { ...ws.metadata, resourceVersion: String(Number(ws.metadata.resourceVersion) + 1) }, status };
    return structuredClone(current);
  };
  const originalApply = kubernetes.applyOwned;
  kubernetes.applyOwned = async (resource, actualTenantId) => {
    const applied = await originalApply(resource, actualTenantId);
    if (resource.kind === "Ingress") {
      ingress = { ...applied, metadata: { ...applied.metadata, uid: "70000000-0000-4000-8000-000000000003", resourceVersion: "9" } };
      current = structuredClone(current);
      current.metadata.generation += 1;
      current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1);
      current.spec.request.fencingToken += 1;
      return ingress;
    }
    return applied;
  };
  kubernetes.getResource = async (_apiVersion, kind) => kind === "Ingress" ? ingress : null;
  kubernetes.deleteOwned = async (_apiVersion, kind, _name, _tenant, _fence, expected) => {
    if (kind === "Ingress" && expected) {
      assert.equal(expected.metadata.resourceVersion, "9");
      ingressDeleteAttempts += 1;
      ingress = { ...ingress, metadata: { ...ingress.metadata, resourceVersion: "10" } };
      throw Object.assign(new Error("resource changed"), { code: "RESOURCE_CHANGED" });
    }
  };
  const provider = {
    ready: async () => true,
    execute: async () => ({
      healthy: true,
      isolation_verified: true,
      zammad_base_url: "https://northstar.support.example.test",
      checked_at: new Date().toISOString(),
    }),
  };
  current = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(current);
  assert.equal(current.status.conditions.find((entry) => entry.type === "Healthy").reason, "PublicationAuthorized");
  await assert.rejects(
    () => new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(current),
    (error) => error?.name === "StaleWorkspaceSnapshotError",
  );
  assert.equal(ingress.metadata.resourceVersion, "10");
  assert.equal(ingressDeleteAttempts, 1);
});

test("publication authorization is bound to the exact workspace resource version", async () => {
  const completed = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults"];
  const stale = withPrior(workspace("health", completed));
  stale.status.observedGeneration = stale.metadata.generation;
  stale.status.observedFencingToken = stale.spec.request.fencingToken;
  stale.status.lastAppliedIdempotencyKey = stale.spec.request.idempotencyKey;
  stale.status.reconciler = "wasalx-workspace-controller/v1";
  stale.status.conditions.push({
    type: "Healthy",
    status: "Unknown",
    reason: "PublicationAuthorized",
    observedGeneration: stale.metadata.generation,
  });
  const current = structuredClone(stale);
  current.metadata.resourceVersion = "41";
  current.status.conditions.find((entry) => entry.type === "Healthy").reason = "DependencyUnavailable";
  let applies = 0;
  const kubernetes = fakeKubernetes({ workspace: current });
  kubernetes.applyOwned = async () => { applies += 1; assert.fail("a stale authorization must not mutate resources"); };
  await assert.rejects(
    () => new WorkspaceControllerReconciler(controllerConfig(), kubernetes, { ready: async () => true, execute: async () => ({}) }).reconcile(stale),
    (error) => error?.name === "StaleWorkspaceSnapshotError",
  );
  assert.equal(applies, 0);
});

test("lease loss after ingress apply performs no compensating mutation", async () => {
  const completed = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults"];
  const ws = withPrior(workspace("health", completed));
  ws.status.observedGeneration = ws.metadata.generation;
  ws.status.observedFencingToken = ws.spec.request.fencingToken;
  ws.status.lastAppliedIdempotencyKey = ws.spec.request.idempotencyKey;
  ws.status.reconciler = "wasalx-workspace-controller/v1";
  ws.status.conditions.push({
    type: "Healthy",
    status: "Unknown",
    reason: "PublicationAuthorized",
    observedGeneration: ws.metadata.generation,
  });
  let leader = true;
  let compensatingDeletes = 0;
  const kubernetes = fakeKubernetes({ workspace: ws });
  const originalApply = kubernetes.applyOwned;
  kubernetes.applyOwned = async (resource, actualTenantId) => {
    const applied = await originalApply(resource, actualTenantId);
    if (resource.kind === "Ingress") leader = false;
    return applied;
  };
  kubernetes.deleteOwned = async (_apiVersion, _kind, _name, _tenant, _fence, expected) => {
    if (expected) compensatingDeletes += 1;
  };
  const provider = {
    ready: async () => true,
    execute: async () => ({
      healthy: true,
      isolation_verified: true,
      zammad_base_url: "https://northstar.support.example.test",
      checked_at: new Date().toISOString(),
    }),
  };
  await assert.rejects(
    () => new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider, () => leader).reconcile(ws),
    ControllerLeadershipLostError,
  );
  assert.equal(compensatingDeletes, 0);
});

test("an ambiguous final status response never withdraws durably authorized ingress", async () => {
  const completed = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults"];
  const ws = withPrior(workspace("health", completed));
  ws.status.observedGeneration = ws.metadata.generation;
  ws.status.observedFencingToken = ws.spec.request.fencingToken;
  ws.status.lastAppliedIdempotencyKey = ws.spec.request.idempotencyKey;
  ws.status.reconciler = "wasalx-workspace-controller/v1";
  ws.status.conditions.push({ type: "Healthy", status: "Unknown", reason: "PublicationAuthorized", observedGeneration: ws.metadata.generation });
  let current = structuredClone(ws);
  let ingress = null;
  let compensatingDeletes = 0;
  const kubernetes = fakeKubernetes({ workspace: ws });
  kubernetes.getWorkspace = async () => structuredClone(current);
  const originalApply = kubernetes.applyOwned;
  kubernetes.applyOwned = async (resource, actualTenantId) => {
    const applied = await originalApply(resource, actualTenantId);
    if (resource.kind === "Ingress") ingress = applied;
    return applied;
  };
  kubernetes.getResource = async (_apiVersion, kind) => kind === "Ingress" ? ingress : null;
  kubernetes.deleteOwned = async (_apiVersion, _kind, _name, _tenant, _fence, expected) => {
    if (expected) compensatingDeletes += 1;
  };
  kubernetes.replaceWorkspaceStatus = async (snapshot, status) => {
    current = {
      ...structuredClone(snapshot),
      metadata: { ...snapshot.metadata, resourceVersion: "41" },
      status,
    };
    throw new Error("status response lost after commit");
  };
  await assert.rejects(
    () => new WorkspaceControllerReconciler(controllerConfig(), kubernetes, {
      ready: async () => true,
      execute: async () => ({ healthy: true, isolation_verified: true, zammad_base_url: "https://northstar.support.example.test", checked_at: new Date().toISOString() }),
    }).reconcile(ws),
    /response lost/u,
  );
  assert.equal(current.status.conditions.find((entry) => entry.type === "Healthy").status, "True");
  assert.ok(ingress);
  assert.equal(compensatingDeletes, 0);
});

test("ingress publication rejects changed UID, workspace, or controller owner on readback", async () => {
  const mutations = [
    (resource) => { resource.metadata.uid = "70000000-0000-4000-8000-000000000099"; },
    (resource) => { resource.metadata.annotations["wasalx.io/workspace"] = "tenant-wrong"; },
    (resource) => { resource.metadata.ownerReferences[0].uid = "40000000-0000-4000-8000-000000000099"; },
  ];
  for (const mutate of mutations) {
    const completed = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults"];
    const ws = withPrior(workspace("health", completed));
    ws.status.observedGeneration = ws.metadata.generation;
    ws.status.observedFencingToken = ws.spec.request.fencingToken;
    ws.status.lastAppliedIdempotencyKey = ws.spec.request.idempotencyKey;
    ws.status.reconciler = "wasalx-workspace-controller/v1";
    ws.status.conditions.push({ type: "Healthy", status: "Unknown", reason: "PublicationAuthorized", observedGeneration: ws.metadata.generation });
    let readback = null;
    const kubernetes = fakeKubernetes({ workspace: ws });
    const originalApply = kubernetes.applyOwned;
    kubernetes.applyOwned = async (resource, actualTenantId) => {
      const applied = await originalApply(resource, actualTenantId);
      if (resource.kind === "Ingress") {
        readback = structuredClone(applied);
        mutate(readback);
      }
      return applied;
    };
    kubernetes.getResource = async (_apiVersion, kind) => kind === "Ingress" ? readback : null;
    const result = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, {
      ready: async () => true,
      execute: async () => ({ healthy: true, isolation_verified: true, zammad_base_url: "https://northstar.support.example.test", checked_at: new Date().toISOString() }),
    }).reconcile(ws);
    const condition = result.status.conditions.find((entry) => entry.type === "Healthy");
    assert.deepEqual([condition.status, condition.reason], ["False", "PolicyDenied"]);
  }
});

test("a newer fence replaces one failed owned configuration job without concurrent execution", async () => {
  const ws = withPrior(workspace("package", ["identity", "database", "search", "storage", "secrets", "zammad"]));
  const desired = buildConfigurationJob(ws, controllerConfig(), "package");
  let failedJob = {
    ...structuredClone(desired),
    metadata: {
      ...desired.metadata,
      uid: "60000000-0000-4000-8000-000000000003",
      resourceVersion: "77",
      annotations: { ...desired.metadata.annotations, "wasalx.io/fencing-token": "8" },
    },
    status: { conditions: [{ type: "Failed", status: "True" }] },
  };
  const deletes = [];
  const kubernetes = fakeKubernetes({ workspace: ws });
  kubernetes.getResource = async (_apiVersion, kind, name) =>
    kind === "Job" && name === desired.metadata.name ? failedJob : null;
  kubernetes.deleteOwned = async (_apiVersion, kind, name) => {
    deletes.push(`${kind}:${name}`);
    if (name === desired.metadata.name) failedJob = null;
  };
  const provider = {
    ready: async () => true,
    execute: async () => ({ package_version: "0.3.0", package_sha256: packageSha }),
  };
  const pending = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(ws);
  assert.equal(pending.status.conditions.find((entry) => entry.type === "PackageReady").status, "Unknown");
  assert.equal(deletes.filter((entry) => entry.startsWith("Ingress:")).length, 1);
  assert.deepEqual(deletes.filter((entry) => entry.startsWith("Job:")), [`Job:${desired.metadata.name}`]);
  const ready = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(pending);
  assert.equal(ready.status.conditions.find((entry) => entry.type === "PackageReady").status, "True");
});

test("a colliding job cannot report failure without the current workspace owner UID", async () => {
  const ws = withPrior(workspace("package", ["identity", "database", "search", "storage", "secrets", "zammad"]));
  const desired = buildConfigurationJob(ws, controllerConfig(), "package");
  const colliding = structuredClone(desired);
  colliding.metadata.uid = "60000000-0000-4000-8000-000000000088";
  colliding.metadata.resourceVersion = "77";
  colliding.metadata.ownerReferences[0].uid = "40000000-0000-4000-8000-000000000088";
  colliding.status = { conditions: [{ type: "Failed", status: "True" }] };
  const deletes = [];
  const kubernetes = fakeKubernetes({ workspace: ws });
  kubernetes.getResource = async (_apiVersion, kind, name) =>
    kind === "Job" && name === desired.metadata.name ? colliding : null;
  kubernetes.deleteOwned = async (_apiVersion, kind) => { deletes.push(kind); };
  const result = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, {
    ready: async () => true,
    execute: async () => ({ package_version: ws.spec.zammad.packageVersion, package_sha256: ws.spec.zammad.packageSha256 }),
  }).reconcile(ws);
  const condition = result.status.conditions.find((entry) => entry.type === "PackageReady");
  assert.deepEqual([condition.status, condition.reason], ["False", "PolicyDenied"]);
  assert.equal(deletes.filter((kind) => kind === "Ingress").length, 1);
  assert.equal(deletes.filter((kind) => kind === "Job").length, 0);
});

test("leader lease is exclusive, renews itself, and only steals expired leases", async () => {
  let lease = null;
  const client = {
    getLease: async () => lease,
    replaceLease: async (_name, next) => {
      lease = { ...next, resourceVersion: String(Number(lease?.resourceVersion ?? 0) + 1) };
      return lease;
    },
  };
  let now = Date.parse("2026-08-09T00:00:00.000Z");
  const elector = new LeaseLeaderElector(controllerConfig(), client, { now: () => now });
  assert.equal(await elector.acquireOrRenew(), true);
  assert.equal(lease.holderIdentity, "controller-a");
  now += 5_000;
  assert.equal(await elector.acquireOrRenew(), true);
  lease = { ...lease, holderIdentity: "controller-b", renewTime: new Date(now).toISOString() };
  assert.equal(await elector.acquireOrRenew(), false);
  now += 31_000;
  assert.equal(await elector.acquireOrRenew(), true);
  assert.equal(lease.holderIdentity, "controller-a");
  assert.equal(lease.leaseTransitions, 1);
});

test("controller publishes exact fenced status only after provider evidence", async () => {
  const ws = workspace();
  const kubernetes = fakeKubernetes({ workspace: ws });
  const provider = {
    ready: async () => true,
    execute: async (action) => {
      assert.equal(action, "identity");
      return {
        identity_id: "keycloak-client-northstar",
        oidc_client_id: `wasalx-${compact}`,
        oidc_secret_reference: `secret://tenants/${tenantId}/zammad/oidc`,
      };
    },
  };
  const result = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(ws);
  assert.equal(result.status.reconciler, "wasalx-workspace-controller/v1");
  assert.equal(result.status.observedGeneration, 5);
  assert.equal(result.status.observedFencingToken, 9);
  assert.equal(result.status.lastAppliedIdempotencyKey, `provision:${tenantId}:${operationId}:identity`);
  assert.equal(result.status.conditions[0].status, "True");
  assert.deepEqual(result.status.outputs.identity, {
    identity_id: "keycloak-client-northstar",
    oidc_client_id: `wasalx-${compact}`,
    oidc_secret_reference: `secret://tenants/${tenantId}/zammad/oidc`,
  });
});

test("controller rejects a missing or non-v4 Zammad instance binding before provider access", async () => {
  const ws = workspace();
  ws.spec.zammad.instanceId = "00000000-0000-0000-0000-000000000000";
  let providerCalled = false;
  await assert.rejects(
    () => new WorkspaceControllerReconciler(controllerConfig(), fakeKubernetes({ workspace: ws }), {
      ready: async () => true,
      execute: async () => { providerCalled = true; return {}; },
    }).reconcile(ws),
    (error) => error?.code === "WORKSPACE_SPEC_INVALID",
  );
  assert.equal(providerCalled, false);
});

test("controller remains Unknown and never calls verifier while Kubernetes health evidence is pending", async () => {
  const ws = withPrior(workspace("zammad", ["identity", "database", "search", "storage", "secrets"]));
  const kubernetes = fakeKubernetes({ deploymentReady: false, workspace: ws });
  let providerCalled = false;
  const provider = { ready: async () => true, execute: async () => { providerCalled = true; return {}; } };
  const result = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(ws);
  assert.equal(providerCalled, false);
  assert.equal(result.status.conditions.find((entry) => entry.type === "ZammadReady").status, "Unknown");
  assert.equal(result.status.outputs.zammad, undefined);
});

test("stale provider health evidence is rejected instead of reactivating an unverified workspace", async () => {
  const ws = withPrior(workspace("health", ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults"]));
  const provider = {
    ready: async () => true,
    execute: async () => ({
      healthy: true,
      isolation_verified: true,
      zammad_base_url: "https://northstar.support.example.test",
      checked_at: "2020-01-01T00:00:00.000Z",
    }),
  };
  const result = await new WorkspaceControllerReconciler(controllerConfig(), fakeKubernetes({ workspace: ws }), provider).reconcile(ws);
  assert.equal(result.status.conditions.find((entry) => entry.type === "Healthy").status, "False");
  assert.equal(result.status.conditions.find((entry) => entry.type === "Healthy").reason, "TerminalFailure");
});

test("verified workspaces are reconciled again so provider and runtime drift cannot become permanent", async () => {
  const ws = workspace();
  ws.status = {
    observedGeneration: 5,
    observedFencingToken: 9,
    lastAppliedIdempotencyKey: `provision:${tenantId}:${operationId}:identity`,
    reconciler: "wasalx-workspace-controller/v1",
    conditions: [{ type: "IdentityReady", status: "True", observedGeneration: 5 }],
    outputs: {
      identity: {
        identity_id: "identity-1",
        oidc_client_id: `wasalx-${compact}`,
        oidc_secret_reference: `secret://tenants/${tenantId}/zammad/oidc`,
      },
    },
  };
  let providerCalls = 0;
  const provider = {
    ready: async () => true,
    execute: async () => {
      providerCalls += 1;
      return ws.status.outputs.identity;
    },
  };
  await new WorkspaceControllerReconciler(controllerConfig(), fakeKubernetes({ workspace: ws }), provider).reconcile(ws);
  assert.equal(providerCalls, 1);
});

test("controller abandons reconciliation without a stale status write as soon as its safe lease is lost", async () => {
  const ws = withPrior(workspace("zammad", ["identity", "database", "search", "storage", "secrets"]));
  let leader = true;
  let statusWrites = 0;
  let providerCalls = 0;
  const kubernetes = fakeKubernetes({ workspace: ws });
  const originalApply = kubernetes.applyOwned;
  kubernetes.applyOwned = async (resource, actualTenantId) => {
    const result = await originalApply(resource, actualTenantId);
    leader = false;
    return result;
  };
  kubernetes.replaceWorkspaceStatus = async () => {
    statusWrites += 1;
    assert.fail("a stale leader must not write status");
  };
  const provider = {
    ready: async () => true,
    execute: async () => {
      providerCalls += 1;
      return {};
    },
  };
  await assert.rejects(
    () => new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider, () => leader).reconcile(ws),
    ControllerLeadershipLostError,
  );
  assert.equal(statusWrites, 0);
  assert.equal(providerCalls, 0);
});

test("suspension drains owned one-shot jobs before credentials are revoked", async () => {
  const ws = withPrior(workspace("suspend", ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"]));
  ws.spec.request.action = "SUSPEND";
  ws.spec.request.idempotencyKey = `suspend:${tenantId}:${ws.spec.request.operationId}`;
  ws.spec.desiredState = "Suspended";
  const activeResources = buildActiveResources(ws, controllerConfig());
  const scheduledBackupMetadata = activeResources.backup.spec.jobTemplate.metadata;
  const workspaceOwner = activeResources.initJob.metadata.ownerReferences;
  const backupCronJob = structuredClone(activeResources.backup);
  backupCronJob.metadata.uid = "60000000-0000-4000-8000-000000000003";
  backupCronJob.metadata.resourceVersion = "49";
  let jobs = [{
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `zammad-${compact}-init-active`,
      namespace: "wasalx-tenants",
      uid: "60000000-0000-4000-8000-000000000001",
      resourceVersion: "50",
      labels: {
        "app.kubernetes.io/managed-by": "wasalx-workspace-controller",
        "wasalx.io/tenant": tenantId,
        "wasalx.io/plane": "tenant",
      },
      annotations: {
        "wasalx.io/workspace": ws.metadata.name,
        "wasalx.io/fencing-token": "8",
        "wasalx.io/idempotency-key-hash": "b".repeat(64),
      },
      ownerReferences: structuredClone(workspaceOwner),
    },
  }, {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `zammad-${compact}-init-durablemarker`,
      namespace: "wasalx-tenants",
      uid: "60000000-0000-4000-8000-000000000002",
      resourceVersion: "51",
      labels: {
        "app.kubernetes.io/managed-by": "wasalx-workspace-controller",
        "wasalx.io/tenant": tenantId,
        "wasalx.io/plane": "tenant",
      },
      annotations: {
        "wasalx.io/workspace": ws.metadata.name,
        "wasalx.io/fencing-token": "8",
        "wasalx.io/idempotency-key-hash": "b".repeat(64),
      },
      ownerReferences: structuredClone(workspaceOwner),
    },
    status: { conditions: [{ type: "Complete", status: "True" }] },
  }, {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      ...structuredClone(scheduledBackupMetadata),
      name: `zammad-${compact}-backup-12345678`,
      namespace: "wasalx-tenants",
      uid: "60000000-0000-4000-8000-000000000004",
      resourceVersion: "52",
      ownerReferences: [{
        apiVersion: "batch/v1",
        kind: "CronJob",
        name: activeResources.backup.metadata.name,
        uid: backupCronJob.metadata.uid,
        controller: true,
      }],
    },
  }];
  const calls = [];
  const kubernetes = fakeKubernetes({ workspace: ws });
  kubernetes.listOwned = async () => jobs;
  kubernetes.getResource = async (_apiVersion, kind, name) =>
    kind === "CronJob" && name === backupCronJob.metadata.name ? backupCronJob : null;
  kubernetes.deleteOwned = async (_apiVersion, kind, name) => {
    calls.push(`delete:${kind}:${name}`);
    if (kind === "Job") jobs = jobs.filter((job) => job.metadata.name !== name);
  };
  const provider = {
    ready: async () => true,
    execute: async (action) => {
      calls.push(`provider:${action}`);
      return {
        suspended: true,
        credentials_disabled: true,
        workloads_scaled_to_zero: true,
        ingress_disabled: true,
        suspended_at: new Date().toISOString(),
      };
    },
  };
  const result = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(ws);
  assert.equal(result.status.conditions.find((entry) => entry.type === "Suspended").status, "True");
  const jobDelete = calls.findIndex((entry) => entry.startsWith("delete:Job:"));
  const providerCall = calls.indexOf("provider:suspend");
  assert.ok(jobDelete >= 0 && providerCall > jobDelete);
  assert.equal(calls.some((entry) => entry.includes("init-durablemarker")), false);
  assert.equal(calls.some((entry) => entry.includes("backup-12345678")), true);
  assert.equal(jobs.some((job) => job.metadata.name.includes("init-durablemarker")), true);
});

test("resumption prepares privately, then publishes ingress only in the authorized phase", async () => {
  const ws = withPrior(workspace("health", ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"]));
  ws.spec.request.action = "RESUME";
  ws.spec.request.resumePhase = "PREPARE";
  ws.spec.request.desiredStep = "resume_prepare";
  ws.spec.request.idempotencyKey = `resume:${tenantId}:${ws.spec.request.operationId}:prepare`;
  const calls = [];
  const kubernetes = fakeKubernetes({ workspace: ws });
  let appliedIngress = null;
  const originalApply = kubernetes.applyOwned;
  kubernetes.applyOwned = async (resource, actualTenantId) => {
    calls.push(`apply:${resource.kind}`);
    const result = await originalApply(resource, actualTenantId);
    if (resource.kind === "Ingress") appliedIngress = result;
    return result;
  };
  kubernetes.getResource = async (_apiVersion, kind) => {
    if (kind === "Ingress") calls.push("get:Ingress");
    return kind === "Ingress" ? appliedIngress : null;
  };
  const provider = {
    ready: async () => true,
    execute: async (action) => {
      calls.push(`provider:${action}`);
      if (action === "resume") return {
        resumed: true,
        credentials_enabled: true,
        provider_resumed_at: new Date().toISOString(),
      };
      return {
        healthy: true,
        isolation_verified: true,
        zammad_base_url: "https://northstar.support.example.test",
        checked_at: new Date().toISOString(),
      };
    },
  };
  const prepared = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(ws);
  assert.equal(prepared.status.conditions.find((entry) => entry.type === "ResumePrepared").status, "True");
  assert.equal(prepared.status.outputs.resume_prepare.prepared, true);
  assert.equal(calls.includes("apply:Ingress"), false);
  assert.ok(calls.indexOf("provider:resume") < calls.indexOf("provider:verify"));

  prepared.metadata.generation += 1;
  prepared.metadata.resourceVersion = "41";
  prepared.spec.request.fencingToken += 1;
  prepared.spec.request.resumePhase = "PUBLISH";
  prepared.spec.request.desiredStep = "resume_publish";
  prepared.spec.request.idempotencyKey = `resume:${tenantId}:${prepared.spec.request.operationId}:publish`;
  const authorized = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(prepared);
  assert.equal(authorized.status.conditions.find((entry) => entry.type === "Resumed").status, "Unknown");
  assert.equal(authorized.status.conditions.find((entry) => entry.type === "Resumed").reason, "PublicationAuthorized");
  assert.equal(calls.includes("apply:Ingress"), false);
  const result = await new WorkspaceControllerReconciler(controllerConfig(), kubernetes, provider).reconcile(authorized);
  assert.equal(result.status.conditions.find((entry) => entry.type === "Resumed").status, "True");
  const providerCall = calls.indexOf("provider:verify");
  const ingressApply = calls.indexOf("apply:Ingress");
  assert.ok(providerCall >= 0 && ingressApply > calls.lastIndexOf("provider:verify"));
  assert.ok(calls.lastIndexOf("get:Ingress") > ingressApply);

  const wrongWorkspace = structuredClone(result);
  const wrongRouteKubernetes = fakeKubernetes({ workspace: wrongWorkspace });
  const wrongRouteApply = wrongRouteKubernetes.applyOwned;
  let wrongIngress = null;
  wrongRouteKubernetes.applyOwned = async (resource, actualTenantId) => {
    const applied = await wrongRouteApply(resource, actualTenantId);
    if (resource.kind === "Ingress") {
      applied.spec.rules[0].host = "wrong-tenant.support.example.test";
      wrongIngress = applied;
    }
    return applied;
  };
  wrongRouteKubernetes.deleteOwned = async (_apiVersion, kind) => {
    if (kind === "Ingress") wrongIngress = null;
  };
  wrongRouteKubernetes.getResource = async (_apiVersion, kind) => {
    return kind === "Ingress" ? wrongIngress : null;
  };
  const wrongRoute = await new WorkspaceControllerReconciler(
    controllerConfig(),
    wrongRouteKubernetes,
    provider,
  ).reconcile(wrongWorkspace);
  assert.equal(wrongRoute.status.conditions.find((entry) => entry.type === "Resumed").status, "False");
  assert.equal(wrongRoute.status.conditions.find((entry) => entry.type === "Resumed").reason, "PolicyDenied");
  assert.equal(wrongRoute.status.outputs.resume, undefined);

  const failedCalls = [];
  const failedWorkspace = structuredClone(result);
  const failedKubernetes = fakeKubernetes({ workspace: failedWorkspace });
  const failedApply = failedKubernetes.applyOwned;
  failedKubernetes.applyOwned = async (resource, actualTenantId) => {
    failedCalls.push(`apply:${resource.kind}`);
    return failedApply(resource, actualTenantId);
  };
  const failed = await new WorkspaceControllerReconciler(
    controllerConfig(),
    failedKubernetes,
    {
      ready: async () => true,
      execute: async () => ({
        healthy: true,
        isolation_verified: true,
        zammad_base_url: "https://northstar.support.example.test",
        checked_at: "2020-01-01T00:00:00.000Z",
      }),
    },
  ).reconcile(failedWorkspace);
  assert.equal(failed.status.conditions.find((entry) => entry.type === "Resumed").status, "False");
  assert.equal(failed.status.outputs.resume, undefined);
  assert.equal(failedCalls.includes("apply:Ingress"), false);
});

test("controller lists only label-scoped tenant resources through the bounded Kubernetes client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-controller-kubernetes-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "rotated-kubernetes-token-12345", { mode: 0o600 });
  let observedUrl = "";
  const fetcher = async (input) => {
    observedUrl = String(input);
    return Response.json({
      apiVersion: "v1",
      kind: "List",
      items: [{
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "owned-job",
          namespace: "wasalx-tenants",
          labels: {
            "app.kubernetes.io/managed-by": "wasalx-workspace-controller",
            "wasalx.io/tenant": tenantId,
            "wasalx.io/plane": "tenant",
          },
          annotations: {
            "wasalx.io/workspace": `tenant-${tenantId}`,
            "wasalx.io/fencing-token": "9",
            "wasalx.io/idempotency-key-hash": "a".repeat(64),
          },
        },
      }],
    });
  };
  try {
    const client = new KubernetesControllerClient(controllerConfig({ kubernetesTokenFile: tokenFile }), fetcher);
    assert.equal((await client.listOwned("batch/v1", "Job", tenantId))[0].metadata.name, "owned-job");
    const url = new URL(observedUrl);
    assert.equal(url.pathname, "/apis/batch/v1/namespaces/wasalx-tenants/jobs");
    assert.match(url.searchParams.get("labelSelector"), /wasalx\.io\/tenant=10000000/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("controller follows Kubernetes continuation tokens for workspaces and owned resources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-controller-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "rotated-kubernetes-token-12345", { mode: 0o600 });
  const config = controllerConfig({ kubernetesTokenFile: tokenFile });
  const next = "opaque+token/with=symbols";
  const urls = [];
  const client = new KubernetesControllerClient(config, async (input) => {
    const url = new URL(input);
    urls.push(url);
    const secondPage = url.searchParams.has("continue");
    if (secondPage) assert.equal(url.searchParams.get("continue"), next);
    const resource = url.pathname.endsWith("tenantworkspaces")
      ? workspace()
      : buildActiveResources(workspace("zammad"), config).nginxConfig;
    resource.metadata.name += secondPage ? "-second" : "-first";
    return Response.json({ items: [resource], metadata: { continue: secondPage ? "" : next } });
  });
  assert.deepEqual((await client.listWorkspaces()).map((item) => item.metadata.name), [
    `tenant-${tenantId}-first`, `tenant-${tenantId}-second`,
  ]);
  const owned = await client.listOwned("v1", "ConfigMap", tenantId);
  assert.equal(owned.length, 2);
  assert.ok(owned[1].metadata.name.endsWith("-second"));
  assert.equal(urls.length, 4);
  assert.ok(urls.every((url) => url.searchParams.get("limit") === "500"));
  assert.equal(urls[2].searchParams.get("labelSelector"), urls[3].searchParams.get("labelSelector"));

  let calls = 0;
  const looping = new KubernetesControllerClient(config, async () => {
    calls += 1;
    return Response.json({ items: [], metadata: { continue: next } });
  });
  await assert.rejects(looping.listWorkspaces(), { code: "WORKSPACE_LIST_INVALID" });
  assert.equal(calls, 2);

  const foreign = buildActiveResources(workspace("zammad"), config).nginxConfig;
  foreign.metadata.labels["wasalx.io/tenant"] = "foreign";
  const unsafe = new KubernetesControllerClient(config, async (input) => Response.json({
    items: new URL(input).searchParams.has("continue") ? [foreign] : [],
    metadata: { continue: new URL(input).searchParams.has("continue") ? "" : next },
  }));
  await assert.rejects(unsafe.listOwned("v1", "ConfigMap", tenantId), { code: "RESOURCE_OWNERSHIP_DENIED" });
});

test("Kubernetes resource writes are create-or-resource-version-preconditioned and deletes bind the observed object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-controller-preconditions-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "rotated-kubernetes-token-12345", { mode: 0o600 });
  const desired = buildActiveResources(workspace("zammad"), controllerConfig()).nginxConfig;
  let stored = null;
  const methods = [];
  const urls = [];
  const fetcher = async (input, init = {}) => {
    methods.push(init.method);
    urls.push(new URL(input));
    if (init.method === "GET") return stored ? Response.json(stored) : new Response(null, { status: 404 });
    const body = JSON.parse(String(init.body));
    if (init.method === "POST") {
      stored = { ...body, metadata: { ...body.metadata, uid: "70000000-0000-4000-8000-000000000001", resourceVersion: "1" } };
      return Response.json(stored, { status: 201 });
    }
    assert.equal(body.metadata.resourceVersion, stored.metadata.resourceVersion);
    stored = { ...body, metadata: { ...body.metadata, uid: stored.metadata.uid, resourceVersion: "2" } };
    return Response.json(stored);
  };
  try {
    const client = new KubernetesControllerClient(controllerConfig({ kubernetesTokenFile: tokenFile }), fetcher);
    await client.applyOwned(desired, tenantId);
    await client.applyOwned(desired, tenantId);
    assert.deepEqual(methods, ["GET", "POST", "GET", "PATCH"]);
    assert.equal(urls[1].searchParams.get("fieldManager"), "wasalx-workspace-controller");
    assert.equal(urls[3].searchParams.get("fieldManager"), "wasalx-workspace-controller");

    const expected = structuredClone(stored);
    stored = { ...structuredClone(stored), metadata: { ...stored.metadata, resourceVersion: "3" } };
    await assert.rejects(
      () => client.deleteOwned(desired.apiVersion, desired.kind, desired.metadata.name, tenantId, 9, expected),
      (error) => error?.code === "RESOURCE_CHANGED",
    );
    assert.equal(methods.at(-1), "GET");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP provider contract uses a rotated token, exact fencing, and fake server evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-workspace-provider-"));
  const tokenFile = join(directory, "token");
  const token = "rotated-provider-token-12345";
  await writeFile(tokenFile, token, { mode: 0o600 });
  const handler = createFakeWorkspaceProviderHandler(token);
  const observed = [];
  const fetcher = async (input, init = {}) => {
    observed.push({ input: String(input), init });
    const url = new URL(input);
    const request = Readable.from(init.body ? [Buffer.from(String(init.body))] : []);
    request.method = init.method;
    request.url = `${url.pathname}${url.search}`;
    request.headers = Object.fromEntries(new Headers(init.headers).entries());
    let statusCode = 200;
    const responseHeaders = new Headers();
    let responseBody = "";
    const response = {
      set statusCode(value) { statusCode = value; },
      get statusCode() { return statusCode; },
      setHeader(name, value) { responseHeaders.set(name, String(value)); },
      end(value = "") { responseBody += String(value); },
    };
    await handler(request, response);
    return new Response(responseBody, { status: statusCode, headers: responseHeaders });
  };
  try {
    const provider = new HttpWorkspaceProvider(controllerConfig({ providerTokenFile: tokenFile }), fetcher);
    const output = await provider.execute("database", workspace("database"));
    assert.equal(output.database_role, `zammad_${compact}`);
    assert.equal(output.database_secret_reference, `secret://tenants/${tenantId}/zammad/database`);
    assert.equal(new Headers(observed[0].init.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(observed[0].init.redirect, "error");
    assert.match(observed[0].input, /\/actions\/database$/);

    let now = 1_800_000_000_000;
    const verifyingProvider = new HttpWorkspaceProvider(
      controllerConfig({ providerTokenFile: tokenFile }),
      fetcher,
      () => now,
    );
    await verifyingProvider.execute("verify", workspace("health"));
    const firstVerificationKey = new Headers(observed.at(-1).init.headers).get("idempotency-key");
    now += 30_000;
    await verifyingProvider.execute("verify", workspace("health"));
    assert.equal(new Headers(observed.at(-1).init.headers).get("idempotency-key"), firstVerificationKey);
    now += 31_000;
    await verifyingProvider.execute("verify", workspace("health"));
    assert.notEqual(new Headers(observed.at(-1).init.headers).get("idempotency-key"), firstVerificationKey);
    assert.match(new Headers(observed.at(-1).init.headers).get("idempotency-key"), /:r30000001$/u);

    const recovered = workspace("health");
    recovered.spec.request.fencingToken += 1;
    now -= 31_000;
    await verifyingProvider.execute("verify", recovered);
    const recoveredKey = new Headers(observed.at(-1).init.headers).get("idempotency-key");
    assert.notEqual(recoveredKey, firstVerificationKey);
    assert.match(recoveredKey, /:r30000000$/u);

    const resumeWorkspace = workspace("resume_prepare");
    resumeWorkspace.spec.request.action = "RESUME";
    resumeWorkspace.spec.request.resumePhase = "PREPARE";
    resumeWorkspace.spec.request.idempotencyKey = `resume:${tenantId}:${resumeWorkspace.spec.request.operationId}:prepare`;
    const resumeEvidence = await verifyingProvider.execute("resume", resumeWorkspace);
    assert.equal(resumeEvidence.credentials_enabled, true);
    assert.match(observed.at(-1).input, /\/actions\/resume$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeKubernetes(options = {}) {
  let currentWorkspace = options.workspace ?? null;
  return {
    listWorkspaces: async () => [],
    getWorkspace: async () => currentWorkspace ? structuredClone(currentWorkspace) : null,
    replaceWorkspaceStatus: async (ws, status) => {
      currentWorkspace = { ...structuredClone(ws), metadata: { ...ws.metadata, resourceVersion: "41" }, status };
      return currentWorkspace;
    },
    applyOwned: async (resource) => {
      const result = structuredClone(resource);
      result.metadata.generation = 1;
      result.metadata.uid ??= "70000000-0000-4000-8000-000000000001";
      result.metadata.resourceVersion ??= "1";
      if (result.kind === "ExternalSecret") result.status = { conditions: [{ type: "Ready", status: "True" }] };
      if (result.kind === "PersistentVolumeClaim") result.status = { phase: "Bound" };
      if (result.kind === "Deployment") result.status = options.deploymentReady === false
        ? { observedGeneration: 1, availableReplicas: 0, replicas: 1, conditions: [] }
        : { observedGeneration: 1, availableReplicas: result.spec.replicas, replicas: result.spec.replicas, conditions: [{ type: "Available", status: "True" }] };
      if (result.kind === "Job") result.status = { conditions: [{ type: "Complete", status: "True" }] };
      return result;
    },
    deleteOwned: async () => {},
    getResource: async () => null,
    listOwned: async () => [],
    getLease: async () => null,
    replaceLease: async (_name, value) => value,
    ready: async () => true,
  };
}

function withPrior(ws) {
  const available = {
    identity: {
      identity_id: "identity-1",
      oidc_client_id: `wasalx-${compact}`,
      oidc_secret_reference: `secret://tenants/${tenantId}/zammad/oidc`,
    },
    database: { database_reference: `postgresql://postgres.svc/zammad_${compact}`, database_role: `zammad_${compact}`, database_secret_reference: `secret://tenants/${tenantId}/zammad/database` },
    search: { search_namespace: `wasalx_${compact}`, search_secret_reference: `secret://tenants/${tenantId}/zammad/search` },
    storage: { storage_prefix: `tenants/${tenantId}/`, storage_secret_reference: `secret://tenants/${tenantId}/zammad/storage` },
    secrets: { service_secret_reference: `secret://tenants/${tenantId}/zammad/service`, privacy_secret_reference: `secret://tenants/${tenantId}/zammad/privacy` },
    zammad: {
      zammad_base_url: "https://northstar.support.example.test",
      deployment_name: `zammad-${compact}`,
      runtime_image: ws.spec.zammad.image,
      package_version: ws.spec.zammad.packageVersion,
      package_sha256: ws.spec.zammad.packageSha256,
    },
    package: { package_version: ws.spec.zammad.packageVersion, package_sha256: ws.spec.zammad.packageSha256 },
    oidc: { oidc_issuer: ws.spec.oidc.issuer, oidc_client_id: ws.spec.oidc.clientId, password_login_disabled: true },
    defaults: { zammad_group_id: "1", retention_days: ws.spec.retentionDays, backup_policy: "daily-encrypted" },
    health: { healthy: true, isolation_verified: true, zammad_base_url: "https://northstar.support.example.test", checked_at: new Date().toISOString() },
  };
  const outputs = Object.fromEntries(ws.spec.request.completedSteps.map((key) => [key, available[key]]));
  ws.status.outputs = outputs;
  ws.status.conditions = Object.keys(outputs).map((key) => ({
    type: key === "health" ? "Healthy" : `${key[0].toUpperCase()}${key.slice(1)}Ready`,
    status: "True",
    observedGeneration: 4,
  }));
  return ws;
}


test("mail setup references only its own optional platform-owned tenant policy", () => {
  const ws = workspace("zammad");
  const resources = buildActiveResources(ws, controllerConfig());
  const expected = { name: "WASALX_MAIL_ALLOWED_HOSTS", valueFrom: { configMapKeyRef: {
    name: `zammad-${compact}-mail-policy`, key: "allowed-hosts", optional: true,
  } } };
  for (const suffix of ["railsserver", "scheduler"]) {
    const deployment = resources.deployments.find(item => item.metadata.name === `zammad-${compact}-${suffix}`);
    assert.ok(deployment);
    assert.deepEqual(deployment.spec.template.spec.containers[0].env.find(item => item.name === "WASALX_MAIL_ALLOWED_HOSTS"), expected);
  }
  assert.equal(JSON.stringify(resources).includes("foreign.support.example.test"), false, "tenant renderer must not hard-code another tenant's host");
});
