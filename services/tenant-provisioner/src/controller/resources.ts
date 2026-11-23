import { createHash } from "node:crypto";
import type { ControllerConfig } from "./config.js";
import type { KubernetesObject } from "./kubernetes.js";
import type { ProvisioningStep, TenantWorkspace } from "../types.js";

const MANAGED_BY = "wasalx-workspace-controller";

export function resourceNames(workspace: TenantWorkspace) {
  const compact = workspace.spec.tenantId.replaceAll("-", "");
  const base = `zammad-${compact}`;
  return {
    base,
    runtimeSecret: `${base}-runtime`,
    data: `${base}-backup-data`,
    ingress: `${base}-ingress`,
    networkPolicy: `${base}-network`,
    disruptionBudget: `${base}-pdb`,
    backup: `${base}-backup`,
    nginxConfig: `${base}-nginx`,
    railsserver: `${base}-railsserver`,
    websocket: `${base}-websocket`,
    scheduler: `${base}-scheduler`,
    redis: `${base}-redis`,
    redisData: `${base}-redis-data`,
    memcached: `${base}-memcached`,
  };
}

export function buildExternalSecret(workspace: TenantWorkspace, config: ControllerConfig): KubernetesObject {
  const names = resourceNames(workspace);
  return resource(workspace, "external-secrets.io/v1beta1", "ExternalSecret", names.runtimeSecret, {
    refreshInterval: "15m",
    secretStoreRef: { name: config.externalSecretStoreName, kind: config.externalSecretStoreKind },
    target: {
      name: names.runtimeSecret,
      creationPolicy: "Owner",
      deletionPolicy: "Delete",
      template: { engineVersion: "v2", metadata: { labels: labels(workspace) } },
    },
    data: [
      secretProperty("DATABASE_URL", workspace.spec.database.secretReference, "url"),
      ...(config.backupEncryption?.mode === "CLIENT_ENVELOPE" ? [secretProperty("BACKUP_DATABASE_URL", workspace.spec.database.secretReference, "backup_url")] : []),
      secretProperty("ELASTICSEARCH_HOST", workspace.spec.search.secretReference, "host"),
      secretProperty("ELASTICSEARCH_PORT", workspace.spec.search.secretReference, "port"),
      secretProperty("ELASTICSEARCH_SCHEMA", workspace.spec.search.secretReference, "schema"),
      secretProperty("ELASTICSEARCH_USER", workspace.spec.search.secretReference, "username"),
      secretProperty("ELASTICSEARCH_PASS", workspace.spec.search.secretReference, "password"),
      // The URL is assembled inside the secret manager. It may contain
      // credentials, but neither the ExternalSecret nor controller observes it.
      secretProperty("S3_URL", workspace.spec.storage.secretReference, "s3_url"),
      // The configurator receives these properties only in action-specific env
      // references. Ordinary Zammad containers never receive backup credentials.
      secretProperty("BACKUP_S3_ENDPOINT", workspace.spec.storage.secretReference, "backup_endpoint"),
      secretProperty("BACKUP_S3_REGION", workspace.spec.storage.secretReference, "backup_region"),
      secretProperty("BACKUP_S3_BUCKET", workspace.spec.storage.secretReference, "backup_bucket"),
      secretProperty("BACKUP_S3_ACCESS_KEY_ID", workspace.spec.storage.secretReference, "backup_access_key_id"),
      secretProperty("BACKUP_S3_SECRET_ACCESS_KEY", workspace.spec.storage.secretReference, "backup_secret_access_key"),
      ...(config.backupEncryption?.mode === "CLIENT_ENVELOPE" ? [] : [secretProperty("BACKUP_S3_KMS_KEY_REFERENCE", workspace.spec.storage.secretReference, "backup_kms_key_reference")]),
      secretProperty("BACKUP_S3_LIFECYCLE_RULE_ID", workspace.spec.storage.secretReference, "backup_lifecycle_rule_id"),
      secretProperty("BACKUP_S3_PROVIDER", workspace.spec.storage.secretReference, "backup_provider"),
      secretProperty("ZAMMAD_SERVICE_TOKEN", workspace.spec.secrets.serviceSecretReference, "token"),
      secretProperty("ZAMMAD_BOOTSTRAP_PASSWORD", workspace.spec.secrets.serviceSecretReference, "bootstrap_password"),
      secretProperty("WASALX_SERVICE_JWT_SECRET", workspace.spec.secrets.serviceSecretReference, "jwt_secret"),
      secretProperty("WASALX_ZAMMAD_INSTANCE_ID", workspace.spec.secrets.serviceSecretReference, "instance_id"),
      ...(config.secureRedis ? [
        secretProperty("REDIS_URL", workspace.spec.secrets.serviceSecretReference, "redis_url"),
        secretProperty("REDIS_PASSWORD", workspace.spec.secrets.serviceSecretReference, "redis_password"),
        secretProperty("REDIS_ACL", workspace.spec.secrets.serviceSecretReference, "redis_acl"),
        secretProperty("REDIS_TLS_CA", workspace.spec.secrets.serviceSecretReference, "redis_ca"),
        secretProperty("REDIS_TLS_CERT", workspace.spec.secrets.serviceSecretReference, "redis_cert"),
        secretProperty("REDIS_TLS_KEY", workspace.spec.secrets.serviceSecretReference, "redis_key"),
      ] : []),
      secretProperty("ZAMMAD_PRIVACY_TOKEN", workspace.spec.secrets.privacySecretReference, "token"),
      secretProperty("WASALX_PRIVACY_KEY", workspace.spec.secrets.privacySecretReference, "key"),
    ],
  });
}

export function buildActiveResources(workspace: TenantWorkspace, config: ControllerConfig) {
  const names = resourceNames(workspace);
  const profile = config.profiles[workspace.spec.resourceProfile];
  const image = workspace.spec.zammad.image;
  const runtimeEnv = zammadEnvironment(workspace, names.runtimeSecret, config);
  const pvc = resource(workspace, "v1", "PersistentVolumeClaim", names.data, {
    accessModes: ["ReadWriteOnce"],
    storageClassName: config.storageClassName,
    resources: { requests: { storage: profile.storage } },
  }, { "wasalx.io/retention-protected": "true" });
  const redisPvc = resource(workspace, "v1", "PersistentVolumeClaim", names.redisData, {
    accessModes: ["ReadWriteOnce"],
    storageClassName: config.storageClassName,
    resources: { requests: { storage: "2Gi" } },
  }, { "wasalx.io/retention-protected": "true" });
  const nginxConfig = configMap(workspace, names.nginxConfig, {
    "nginx.conf": nginxConfigText(names),
  });
  const services = [
    service(workspace, names.base, names.base, [{ name: "http", port: 80, targetPort: "http" }]),
    service(workspace, names.railsserver, names.railsserver, [{ name: "rails", port: 3000, targetPort: "rails" }]),
    service(workspace, names.websocket, names.websocket, [{ name: "websocket", port: 6042, targetPort: "websocket" }]),
    service(workspace, names.redis, names.redis, [{ name: "redis", port: 6379, targetPort: "redis" }]),
    service(workspace, names.memcached, names.memcached, [{ name: "memcached", port: 11211, targetPort: "memcached" }]),
  ];
  const deployments = [
    deployment(workspace, names.base, profile.replicas, nginxContainer(workspace.spec.zammad.nginxImage, names), profile),
    deployment(workspace, names.railsserver, profile.replicas, zammadContainer(image, "zammad-railsserver", "rails", 3000, runtimeEnv, profile, config.secureRedis), profile, false, redisClientVolumes(names.runtimeSecret, config.secureRedis), redisTrustInitContainers(image, config.secureRedis)),
    deployment(workspace, names.websocket, 1, zammadContainer(image, "zammad-websocket", "websocket", 6042, runtimeEnv, profile, config.secureRedis), profile, true, redisClientVolumes(names.runtimeSecret, config.secureRedis), redisTrustInitContainers(image, config.secureRedis)),
    deployment(workspace, names.scheduler, 1, zammadContainer(image, "zammad-scheduler", undefined, undefined, runtimeEnv, profile, config.secureRedis), profile, true, redisClientVolumes(names.runtimeSecret, config.secureRedis), redisTrustInitContainers(image, config.secureRedis)),
    deployment(
      workspace,
      names.redis,
      1,
      config.secureRedis
        ? secureRedisContainer(workspace.spec.zammad.redisImage, names.runtimeSecret)
        : dependencyContainer("redis", workspace.spec.zammad.redisImage, "redis", 6379, [{ name: "redis-data", mountPath: "/data" }]),
      profile,
      true,
      [
        { name: "redis-data", persistentVolumeClaim: { claimName: names.redisData } },
        ...(config.secureRedis ? [redisServerVolume(names.runtimeSecret)] : []),
      ],
    ),
    deployment(workspace, names.memcached, 1, dependencyContainer("memcached", workspace.spec.zammad.memcachedImage, "memcached", 11211), profile, true),
  ];
  const initJob = zammadInitJob(workspace, image, runtimeEnv, names.runtimeSecret, config);
  const ingress = resource(workspace, "networking.k8s.io/v1", "Ingress", names.ingress, {
    ingressClassName: config.ingressClassName,
    tls: [{ hosts: [workspace.spec.zammad.hostname], secretName: `${names.base}-tls` }],
    rules: [{
      host: workspace.spec.zammad.hostname,
      http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: names.base, port: { name: "http" } } } }] },
    }],
  }, {
    "cert-manager.io/cluster-issuer": config.clusterIssuer,
    "nginx.ingress.kubernetes.io/ssl-redirect": "true",
  });
  const pdb = resource(workspace, "policy/v1", "PodDisruptionBudget", names.disruptionBudget, {
    maxUnavailable: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": names.railsserver, "wasalx.io/tenant": workspace.spec.tenantId } },
  });
  const networkPolicy = resource(workspace, "networking.k8s.io/v1", "NetworkPolicy", names.networkPolicy, {
    podSelector: { matchLabels: { "wasalx.io/tenant": workspace.spec.tenantId } },
    policyTypes: ["Ingress", "Egress"],
    ingress: [
      { from: [{ podSelector: { matchLabels: { "wasalx.io/tenant": workspace.spec.tenantId } } }] },
      {
        from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": config.ingressNamespace } } }],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
      {
        from: [{ podSelector: { matchLabels: { "wasalx.io/plane": "control" }, matchExpressions: [{ key: "app.kubernetes.io/name", operator: "In", values: ["wasalx-api", "wasalx-worker"] }] } }],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ],
    egress: [
      {
        to: [{ podSelector: { matchLabels: { "wasalx.io/tenant": workspace.spec.tenantId } } }],
      },
      {
        to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
        ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
      },
      {
        to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wasalx-api", "wasalx.io/plane": "control" } } }],
        ports: [{ protocol: "TCP", port: 3001 }],
      },
      ...config.allowedEgress.map((entry) => ({
        to: [{ ipBlock: { cidr: entry.cidr } }],
        ports: entry.ports.map((port) => ({ protocol: "TCP", port })),
      })),
    ],
  });
  const backup = resource(workspace, "batch/v1", "CronJob", names.backup, {
    schedule: config.backupSchedule,
    suspend: false,
    concurrencyPolicy: "Forbid",
    successfulJobsHistoryLimit: 2,
    failedJobsHistoryLimit: 3,
    jobTemplate: {
      metadata: {
        labels: labels(workspace),
        annotations: ownershipAnnotations(workspace),
      },
      spec: {
        backoffLimit: 2,
        activeDeadlineSeconds: 3_600,
        template: configuratorPod(workspace, config, "backup", names.data),
      },
    },
  });
  return { pvc, redisPvc, nginxConfig, services, deployments, initJob, ingress, pdb, networkPolicy, backup };
}

export function buildConfigurationJob(
  workspace: TenantWorkspace,
  config: ControllerConfig,
  step: Extract<ProvisioningStep, "package" | "oidc" | "defaults">,
) {
  const names = resourceNames(workspace);
  const suffix = createHash("sha256")
    .update(`${workspace.spec.request.idempotencyKey}:${step}`)
    .digest("hex")
    .slice(0, 10);
  return resource(workspace, "batch/v1", "Job", `${names.base}-${step}-${suffix}`, {
    backoffLimit: 3,
    activeDeadlineSeconds: 1_800,
    ttlSecondsAfterFinished: 86_400,
    template: configuratorPod(workspace, config, step, names.data),
  });
}

export function buildSuspendedResources(workspace: TenantWorkspace, config: ControllerConfig) {
  const active = buildActiveResources(workspace, config);
  const deployments = active.deployments.map((value) => {
    const copy = structuredClone(value);
    if (copy.spec) copy.spec.replicas = 0;
    return copy;
  });
  const backup = structuredClone(active.backup);
  if (backup.spec) backup.spec.suspend = true;
  return { deployments, backup };
}

function deployment(
  workspace: TenantWorkspace,
  name: string,
  replicas: number,
  container: Record<string, unknown>,
  profile: ControllerConfig["profiles"]["small"],
  singleton = false,
  additionalVolumes: Array<Record<string, unknown>> = [],
  initContainers: Array<Record<string, unknown>> = [],
) {
  const componentLabels = { ...labels(workspace), "app.kubernetes.io/name": name };
  return resource(workspace, "apps/v1", "Deployment", name, {
    replicas,
    revisionHistoryLimit: 3,
    strategy: singleton
      ? { type: "Recreate" }
      : { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
    selector: { matchLabels: { "app.kubernetes.io/name": name, "wasalx.io/tenant": workspace.spec.tenantId } },
    template: {
      metadata: {
        labels: componentLabels,
        annotations: {
          "wasalx.io/zammad-version": workspace.spec.zammad.version,
          "wasalx.io/package-sha256": workspace.spec.zammad.packageSha256,
          ...(container.name === "nginx" ? {
            "wasalx.io/nginx-config-sha256": createHash("sha256").update(nginxConfigText(resourceNames(workspace))).digest("hex"),
          } : {}),
        },
      },
      spec: {
        automountServiceAccountToken: false,
        securityContext: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" }, fsGroup: 1000 },
        ...(initContainers.length ? { initContainers } : {}),
        containers: [{
          ...container,
          resources: "resources" in container ? container.resources : {
            requests: { cpu: fractionCpu(profile.cpu), memory: fractionMemory(profile.memory) },
            limits: { cpu: profile.cpu, memory: profile.memory },
          },
        }],
        volumes: [
          { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
          { name: "nginx-config", configMap: { name: resourceNames(workspace).nginxConfig } },
          ...additionalVolumes,
        ],
      },
    },
  });
}

function zammadContainer(
  image: string,
  command: string,
  portName: string | undefined,
  port: number | undefined,
  environment: Array<Record<string, unknown>>,
  profile: ControllerConfig["profiles"]["small"],
  secureRedis: boolean,
) {
  return {
    name: command,
    image,
    imagePullPolicy: "IfNotPresent",
    command: ["/usr/local/bin/wasalx-zammad-entrypoint", command],
    securityContext: securityContext(),
    env: command === "zammad-railsserver"
      ? [...environment, { name: "RAILS_SERVE_STATIC_FILES", value: "true" }]
      : environment,
    ...(portName && port ? {
      ports: [{ name: portName, containerPort: port, protocol: "TCP" }],
      startupProbe: { tcpSocket: { port: portName }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 36 },
      readinessProbe: { tcpSocket: { port: portName }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 6 },
      livenessProbe: { tcpSocket: { port: portName }, periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    } : {}),
    resources: {
      requests: { cpu: fractionCpu(profile.cpu), memory: fractionMemory(profile.memory) },
      limits: { cpu: profile.cpu, memory: profile.memory },
    },
    volumeMounts: [
      { name: "tmp", mountPath: "/opt/zammad/tmp" },
      ...(secureRedis ? [{ name: "redis-trust", mountPath: "/run/wasalx/trust", readOnly: true }] : []),
    ],
  };
}

function nginxContainer(image: string, names: ReturnType<typeof resourceNames>) {
  return {
    name: "nginx",
    image,
    imagePullPolicy: "IfNotPresent",
    securityContext: securityContext(),
    ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    startupProbe: { tcpSocket: { port: "http" }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 24 },
    readinessProbe: { httpGet: { path: "/api/v1/wasalx/health", port: "http" }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 6 },
    livenessProbe: { tcpSocket: { port: "http" }, periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    volumeMounts: [
      { name: "tmp", mountPath: "/tmp" },
      { name: "nginx-config", mountPath: "/etc/nginx/nginx.conf", subPath: "nginx.conf", readOnly: true },
    ],
    env: [{ name: "UPSTREAM_RAILSSERVER", value: names.railsserver }],
  };
}

function dependencyContainer(
  name: string,
  image: string,
  portName: string,
  port: number,
  additionalVolumeMounts: Array<Record<string, unknown>> = [],
) {
  return {
    name,
    image,
    imagePullPolicy: "IfNotPresent",
    securityContext: securityContext(),
    ports: [{ name: portName, containerPort: port, protocol: "TCP" }],
    readinessProbe: { tcpSocket: { port: portName }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 6 },
    livenessProbe: { tcpSocket: { port: portName }, periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
    resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
    volumeMounts: [{ name: "tmp", mountPath: "/tmp" }, ...additionalVolumeMounts],
  };
}

function secureRedisContainer(image: string, secretName: string) {
  return {
    ...dependencyContainer("redis", image, "redis", 6379, [
      { name: "redis-data", mountPath: "/data" },
      { name: "redis-server-security", mountPath: "/run/wasalx/redis", readOnly: true },
    ]),
    command: ["redis-server"],
    args: [
      "--appendonly", "yes", "--save", "60", "1", "--port", "0", "--tls-port", "6379",
      "--tls-cert-file", "/run/wasalx/redis/tls.crt", "--tls-key-file", "/run/wasalx/redis/tls.key",
      "--tls-ca-cert-file", "/run/wasalx/redis/ca.crt", "--tls-auth-clients", "no",
      "--aclfile", "/run/wasalx/redis/users.acl",
    ],
    env: [secretEnv("REDISCLI_AUTH", secretName, "REDIS_PASSWORD")],
    readinessProbe: redisTlsProbe(),
    livenessProbe: redisTlsProbe(),
  };
}

function redisTlsProbe() {
  return {
    exec: { command: ["redis-cli", "--tls", "--cacert", "/run/wasalx/redis/ca.crt", "--user", "zammad", "ping"] },
    periodSeconds: 10,
    timeoutSeconds: 3,
    failureThreshold: 6,
  };
}

function redisClientVolumes(secretName: string, secure: boolean) {
  return secure ? [
    {
      name: "redis-ca",
      secret: { secretName, defaultMode: 0o440, items: [{ key: "REDIS_TLS_CA", path: "ca.crt" }] },
    },
    { name: "redis-trust", emptyDir: { sizeLimit: "2Mi" } },
  ] : [];
}

export function redisTrustInitContainers(image: string, secure: boolean) {
  return secure ? [{
    name: "redis-trust",
    image,
    imagePullPolicy: "IfNotPresent",
    command: ["sh", "-c", "cat /etc/ssl/certs/ca-certificates.crt /run/wasalx/redis/ca.crt > /run/wasalx/trust/ca-bundle.crt"],
    securityContext: securityContext(),
    resources: { requests: { cpu: "5m", memory: "16Mi" }, limits: { cpu: "50m", memory: "32Mi" } },
    volumeMounts: [
      { name: "redis-ca", mountPath: "/run/wasalx/redis", readOnly: true },
      { name: "redis-trust", mountPath: "/run/wasalx/trust" },
    ],
  }] : [];
}

function redisServerVolume(secretName: string) {
  return {
    name: "redis-server-security",
    secret: {
      secretName,
      defaultMode: 0o440,
      items: [
        { key: "REDIS_ACL", path: "users.acl" },
        { key: "REDIS_TLS_CA", path: "ca.crt" },
        { key: "REDIS_TLS_CERT", path: "tls.crt" },
        { key: "REDIS_TLS_KEY", path: "tls.key" },
      ],
    },
  };
}

function zammadInitJob(workspace: TenantWorkspace, image: string, environment: Array<Record<string, unknown>>, secretName: string, config: ControllerConfig) {
  const { secureRedis, zammadDisplayTimeZone } = config;
  const suffix = createHash("sha256")
    .update(JSON.stringify([
      "init-contract-v5-native-setup-service-identity",
      image,
      workspace.spec.zammad.version,
      workspace.spec.zammad.packageVersion,
      workspace.spec.zammad.packageSha256,
      workspace.spec.owner.oidcSubject,
      workspace.spec.owner.email,
      workspace.spec.owner.displayName,
      workspace.spec.oidc.issuer,
      workspace.spec.oidc.clientId,
      workspace.spec.defaults.initialGroup,
      zammadDisplayTimeZone,
      secureRedis,
    ]))
    .digest("hex")
    .slice(0, 10);
  return resource(workspace, "batch/v1", "Job", `${resourceNames(workspace).base}-init-${suffix}`, {
    backoffLimit: 0,
    activeDeadlineSeconds: 3_600,
    template: {
      metadata: { labels: { ...labels(workspace), "app.kubernetes.io/name": `${resourceNames(workspace).base}-init` } },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        securityContext: { seccompProfile: { type: "RuntimeDefault" }, fsGroup: 1000 },
        // Only the upstream one-shot initializer receives root. Package
        // migration and runtime bootstrap execute in the ordinary UID/GID
        // 1000 container after the initializer has completed.
        initContainers: [{
          name: "zammad-init",
          image,
          resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
          imagePullPolicy: "IfNotPresent",
          command: [
            "bash",
            "-lc",
            `${secureRedis ? "cat /etc/ssl/certs/ca-certificates.crt /run/wasalx/redis/ca.crt > /run/wasalx/trust/ca-bundle.crt && " : ""}/usr/local/bin/wasalx-zammad-entrypoint zammad-init`,
          ],
          securityContext: initSecurityContext(),
          env: environment.map(entry => entry.name === "RAILS_CHECK_PENDING_MIGRATIONS"
            ? { name: entry.name, value: "false" }
            : entry),
          volumeMounts: [
            { name: "tmp", mountPath: "/opt/zammad/tmp" },
            ...(secureRedis ? [
              { name: "redis-ca", mountPath: "/run/wasalx/redis", readOnly: true },
              { name: "redis-trust", mountPath: "/run/wasalx/trust" },
            ] : []),
          ],
        }],
        containers: [{
          name: "wasalx-install-bootstrap",
          image,
          resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "2", memory: "2Gi" } },
          imagePullPolicy: "IfNotPresent",
          command: ["bash", "-lc", "wasalx-package-install && wasalx-runtime-bootstrap"],
          securityContext: securityContext(),
          env: [
            ...environment,
            { name: "WASALX_PACKAGE_VERSION", value: workspace.spec.zammad.packageVersion },
            { name: "WASALX_PACKAGE_SHA256", value: workspace.spec.zammad.packageSha256 },
            secretEnv("ZAMMAD_SERVICE_TOKEN", secretName, "ZAMMAD_SERVICE_TOKEN"),
            secretEnv("ZAMMAD_PRIVACY_TOKEN", secretName, "ZAMMAD_PRIVACY_TOKEN"),
            secretEnv("WASALX_ZAMMAD_BOOTSTRAP_PASSWORD", secretName, "ZAMMAD_BOOTSTRAP_PASSWORD"),
            { name: "WASALX_ZAMMAD_BOOTSTRAP_EMAIL", value: workspace.spec.owner.email },
            { name: "WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT", value: workspace.spec.owner.oidcSubject },
            { name: "WASALX_ZAMMAD_BOOTSTRAP_NAME", value: workspace.spec.owner.displayName },
            { name: "WASALX_ZAMMAD_DISPLAY_TIMEZONE", value: zammadDisplayTimeZone },
            { name: "WASALX_SERVICE_IDENTITY_MODE", value: "fresh" },
            { name: "WASALX_BOOTSTRAP_OIDC_ISSUER", value: workspace.spec.oidc.issuer },
            { name: "WASALX_BOOTSTRAP_OIDC_CLIENT_ID", value: workspace.spec.oidc.clientId },
            { name: "WASALX_BOOTSTRAP_INITIAL_GROUP", value: workspace.spec.defaults.initialGroup },
          ],
          volumeMounts: [
            { name: "tmp", mountPath: "/opt/zammad/tmp" },
            ...(secureRedis ? [
              { name: "redis-trust", mountPath: "/run/wasalx/trust", readOnly: true },
            ] : []),
          ],
        }],
        volumes: [
          { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
          ...redisClientVolumes(secretName, secureRedis),
        ],
      },
    },
  });
}

function configuratorPod(workspace: TenantWorkspace, config: ControllerConfig, action: string, pvcName: string) {
  return {
    metadata: { labels: { ...labels(workspace), "app.kubernetes.io/name": `${resourceNames(workspace).base}-configurator` } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      securityContext: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" }, fsGroup: 1000 },
      containers: [configuratorContainer(workspace, config, action)],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: pvcName } },
        { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
        ...(action === "backup" && config.backupEncryption?.mode === "CLIENT_ENVELOPE" ? [
          { name: "backup-ca", configMap: { name: "wasalx-internal-ca", items: [{ key: "ca.crt", path: "ca.crt" }] } },
        ] : []),
      ],
    },
  };
}

function configuratorContainer(workspace: TenantWorkspace, config: ControllerConfig, action: string) {
  const secretName = resourceNames(workspace).runtimeSecret;
  const actionSecrets = action === "backup"
    ? [
        secretEnv("DATABASE_URL", secretName, config.backupEncryption?.mode === "CLIENT_ENVELOPE" ? "BACKUP_DATABASE_URL" : "DATABASE_URL"),
        secretEnv("BACKUP_S3_ENDPOINT", secretName, "BACKUP_S3_ENDPOINT"),
        secretEnv("BACKUP_S3_REGION", secretName, "BACKUP_S3_REGION"),
        secretEnv("BACKUP_S3_BUCKET", secretName, "BACKUP_S3_BUCKET"),
        secretEnv("BACKUP_S3_ACCESS_KEY_ID", secretName, "BACKUP_S3_ACCESS_KEY_ID"),
        secretEnv("BACKUP_S3_SECRET_ACCESS_KEY", secretName, "BACKUP_S3_SECRET_ACCESS_KEY"),
        ...(config.backupEncryption?.mode === "CLIENT_ENVELOPE" ? [
          { name: "BACKUP_ENCRYPTION_MODE", value: "CLIENT_ENVELOPE" },
          { name: "BACKUP_AGE_RECIPIENT", value: config.backupEncryption.ageRecipient },
          { name: "NODE_EXTRA_CA_CERTS", value: "/backup-ca/ca.crt" },
          { name: "BACKUP_CA_CERT_FILE", value: "/backup-ca/ca.crt" },
        ] : [secretEnv("BACKUP_S3_KMS_KEY_REFERENCE", secretName, "BACKUP_S3_KMS_KEY_REFERENCE")]),
        secretEnv("BACKUP_S3_LIFECYCLE_RULE_ID", secretName, "BACKUP_S3_LIFECYCLE_RULE_ID"),
        secretEnv("BACKUP_S3_PROVIDER", secretName, "BACKUP_S3_PROVIDER"),
      ]
    : [secretEnv("ZAMMAD_SERVICE_TOKEN", secretName, "ZAMMAD_SERVICE_TOKEN")];
  return {
    name: "wasalx-configurator",
    image: workspace.spec.zammad.configuratorImage,
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } },
    imagePullPolicy: "IfNotPresent",
    args: [action],
    securityContext: securityContext(),
    env: [
      ...actionSecrets,
      { name: "TENANT_ID", value: workspace.spec.tenantId },
      { name: "ZAMMAD_BASE_URL", value: `http://${resourceNames(workspace).base}` },
      { name: "WASALX_PACKAGE_VERSION", value: workspace.spec.zammad.packageVersion },
      { name: "WASALX_PACKAGE_SHA256", value: workspace.spec.zammad.packageSha256 },
      { name: "OIDC_ISSUER", value: workspace.spec.oidc.issuer },
      { name: "OIDC_CLIENT_ID", value: workspace.spec.oidc.clientId },
      { name: "OIDC_DISABLE_PASSWORD_LOGIN", value: "true" },
      { name: "DEFAULT_ZAMMAD_GROUP", value: workspace.spec.defaults.initialGroup },
      { name: "RETENTION_DAYS", value: String(workspace.spec.retentionDays) },
      { name: "BACKUP_POLICY", value: workspace.spec.defaults.backupPolicy },
      { name: "DATABASE_NAME", value: workspace.spec.database.databaseName },
      { name: "WORKSPACE_REGION", value: workspace.spec.region },
      { name: "OBJECT_STORAGE_PREFIX", value: workspace.spec.storage.prefix },
      { name: "BACKUP_TIMEOUT_MS", value: "3000000" },
    ],
    volumeMounts: [
      { name: "data", mountPath: "/var/backups/wasalx" },
      { name: "tmp", mountPath: "/tmp" },
      ...(action === "backup" && config.backupEncryption?.mode === "CLIENT_ENVELOPE" ? [
        { name: "backup-ca", mountPath: "/backup-ca", readOnly: true },
      ] : []),
    ],
  };
}

function zammadEnvironment(workspace: TenantWorkspace, secretName: string, config: ControllerConfig) {
  const names = resourceNames(workspace);
  return [
    secretEnv("DATABASE_URL", secretName, "DATABASE_URL"),
    secretEnv("ELASTICSEARCH_HOST", secretName, "ELASTICSEARCH_HOST"),
    secretEnv("ELASTICSEARCH_PORT", secretName, "ELASTICSEARCH_PORT"),
    secretEnv("ELASTICSEARCH_SCHEMA", secretName, "ELASTICSEARCH_SCHEMA"),
    secretEnv("ELASTICSEARCH_USER", secretName, "ELASTICSEARCH_USER"),
    secretEnv("ELASTICSEARCH_PASS", secretName, "ELASTICSEARCH_PASS"),
    secretEnv("S3_URL", secretName, "S3_URL"),
    secretEnv("WASALX_SERVICE_JWT_SECRET", secretName, "WASALX_SERVICE_JWT_SECRET"),
    secretEnv("WASALX_ZAMMAD_INSTANCE_ID", secretName, "WASALX_ZAMMAD_INSTANCE_ID"),
    { name: "WASALX_TENANT_ID", value: workspace.spec.tenantId },
    { name: "WASALX_CONTROL_URL", value: config.controlPlaneUrl.toString() },
    { name: "WASALX_PORTAL_URL", value: config.portalUrl.toString() },
    // Platform-owned tenant policy; absent ConfigMap/key leaves setup fail-closed.
    { name: "WASALX_MAIL_ALLOWED_HOSTS", valueFrom: { configMapKeyRef: {
      name: `${names.base}-mail-policy`, key: "allowed-hosts", optional: true,
    } } },
    { name: "ELASTICSEARCH_ENABLED", value: "true" },
    { name: "ELASTICSEARCH_NAMESPACE", value: workspace.spec.search.namespace },
    ...(config.secureRedis ? [
      secretEnv("REDIS_URL", secretName, "REDIS_URL"),
      { name: "SSL_CERT_FILE", value: "/run/wasalx/trust/ca-bundle.crt" },
    ] : [{ name: "REDIS_URL", value: `redis://${names.redis}:6379` }]),
    { name: "MEMCACHE_SERVERS", value: `${names.memcached}:11211` },
    { name: "ZAMMAD_FQDN", value: workspace.spec.zammad.hostname },
    { name: "ZAMMAD_HTTP_TYPE", value: "https" },
    { name: "POSTGRESQL_DB_CREATE", value: "false" },
    { name: "RAILS_CHECK_PENDING_MIGRATIONS", value: "true" },
    { name: "TMP", value: "/opt/zammad/tmp/wasalx" },
    { name: "RAILS_TRUSTED_PROXIES", value: "['127.0.0.1', '::1']" },
  ];
}

function secretEnv(name: string, secretName: string, key: string) {
  return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
}

function service(workspace: TenantWorkspace, name: string, selectorName: string, ports: Array<Record<string, unknown>>) {
  return resource(workspace, "v1", "Service", name, {
    selector: { "app.kubernetes.io/name": selectorName, "wasalx.io/tenant": workspace.spec.tenantId },
    ports: ports.map((port) => ({ ...port, protocol: "TCP" })),
  });
}

function configMap(workspace: TenantWorkspace, name: string, data: Record<string, string>): KubernetesObject {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: workspace.metadata.namespace,
      labels: labels(workspace),
      annotations: ownershipAnnotations(workspace),
      ownerReferences: ownerReferences(workspace),
    },
    data,
  };
}

function nginxConfigText(names: ReturnType<typeof resourceNames>) {
  return `worker_processes auto;
pid /tmp/nginx.pid;
events { worker_connections 1024; }
http {
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  access_log /dev/stdout;
  error_log /dev/stderr warn;
  upstream railsserver { server ${names.railsserver}:3000; }
  server {
    listen 8080;
    absolute_redirect off;
    server_tokens off;
    client_max_body_size 50m;
    location ^~ /api/v1/ {
      proxy_pass http://railsserver;
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header CLIENT_IP $remote_addr;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-User "";
    }
    location = /auth/openid_connect/backchannel_logout {
      proxy_pass http://railsserver;
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location / { return 404; }
  }
}
`;
}

function secretProperty(secretKey: string, reference: string, property: string) {
  if (!reference.startsWith("secret://") || reference.length > 1_024) throw new ResourceContractError("SECRET_REFERENCE_INVALID");
  return { secretKey, remoteRef: { key: reference.slice("secret://".length), property, decodingStrategy: "None" } };
}

function resource(
  workspace: TenantWorkspace,
  apiVersion: string,
  kind: string,
  name: string,
  spec: Record<string, unknown>,
  additionalAnnotations: Record<string, string> = {},
): KubernetesObject {
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      namespace: workspace.metadata.namespace,
      labels: labels(workspace),
      annotations: ownershipAnnotations(workspace, additionalAnnotations),
      ...(kind === "PersistentVolumeClaim" ? {} : { ownerReferences: ownerReferences(workspace) }),
    },
    spec,
  };
}

function ownershipAnnotations(workspace: TenantWorkspace, additional: Record<string, string> = {}) {
  return {
    "wasalx.io/workspace": workspace.metadata.name,
    "wasalx.io/idempotency-key-hash": createHash("sha256").update(workspace.spec.request.idempotencyKey).digest("hex"),
    "wasalx.io/fencing-token": String(workspace.spec.request.fencingToken),
    ...additional,
  };
}

function labels(workspace: TenantWorkspace) {
  return {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "app.kubernetes.io/part-of": "wasalx",
    "wasalx.io/tenant": workspace.spec.tenantId,
    "wasalx.io/plane": "tenant",
  };
}

function ownerReferences(workspace: TenantWorkspace) {
  const uid = workspace.metadata.uid;
  if (!uid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(uid)) {
    throw new ResourceContractError("WORKSPACE_UID_INVALID");
  }
  return [{
    apiVersion: workspace.apiVersion,
    kind: workspace.kind,
    name: workspace.metadata.name,
    uid,
    controller: true,
    blockOwnerDeletion: false,
  }];
}

function securityContext() {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
}

function initSecurityContext() {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsUser: 0,
    runAsGroup: 0,
    runAsNonRoot: false,
    capabilities: { drop: ["ALL"] },
  };
}

function fractionCpu(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${Math.max(100, Math.floor(parsed * 500))}m` : value;
}

function fractionMemory(value: string) {
  const match = /^(\d+)Gi$/u.exec(value);
  return match ? `${Math.max(256, Math.floor(Number(match[1]) * 512))}Mi` : value;
}

export class ResourceContractError extends Error {
  constructor(readonly code: string) {
    super("The tenant resource specification is unsupported.");
    this.name = "ResourceContractError";
  }
}
