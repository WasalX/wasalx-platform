import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { wasalxTimeZone } from "@wasalx/core/display-time-zone";
import { privateKubernetesUrl } from "../config.js";

export type ResourceProfile = {
  cpu: string;
  memory: string;
  storage: string;
  replicas: number;
};

export type ControllerConfig = {
  port: number;
  kubernetesApiUrl: URL;
  kubernetesTokenFile: string;
  namespace: string;
  identity: string;
  instanceId: string;
  leaseName: string;
  leaseDurationSeconds: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  providerUrl: URL;
  controlPlaneUrl: URL;
  portalUrl: URL;
  providerTokenFile: string;
  providerTimeoutMs: number;
  externalSecretStoreName: string;
  externalSecretStoreKind: "ClusterSecretStore" | "SecretStore";
  baseDomain: string;
  ingressClassName: string;
  ingressNamespace: string;
  clusterIssuer: string;
  storageClassName: string;
  secureRedis: boolean;
  profiles: Record<"small" | "medium" | "large", ResourceProfile>;
  backupSchedule: string;
  zammadDisplayTimeZone: string;
  backupEncryption: { mode: "SSE_KMS" } | { mode: "CLIENT_ENVELOPE"; ageRecipient: string };
  allowedEgress: Array<{ cidr: string; ports: number[] }>;
};

export function loadControllerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ControllerConfig {
  const production = environment.NODE_ENV === "production";
  const providerUrl = privateServiceUrl(
    required(environment.WORKSPACE_PROVIDER_URL, "WORKSPACE_PROVIDER_URL"),
    production,
    environment.ALLOW_INSECURE_WORKSPACE_PROVIDER === "true",
    "WORKSPACE_PROVIDER_URL",
  );
  const controlPlaneUrl = privateServiceUrl(
    required(environment.WASALX_CONTROL_URL, "WASALX_CONTROL_URL"),
    production,
    environment.ALLOW_INSECURE_WASALX_CONTROL_URL === "true",
    "WASALX_CONTROL_URL",
  );
  const portalUrl = publicOriginUrl(
    required(environment.WASALX_PORTAL_URL, "WASALX_PORTAL_URL"),
    production,
    environment.ALLOW_INSECURE_WASALX_PORTAL_URL === "true",
  );
  const leaseDurationSeconds = integer(
    environment.CONTROLLER_LEASE_DURATION_SECONDS,
    120,
    15,
    120,
    "CONTROLLER_LEASE_DURATION_SECONDS",
  );
  const pollIntervalMs = integer(
    environment.CONTROLLER_POLL_INTERVAL_MS,
    5_000,
    1_000,
    60_000,
    "CONTROLLER_POLL_INTERVAL_MS",
  );
  const requestTimeoutMs = integer(
    environment.KUBERNETES_REQUEST_TIMEOUT_MS,
    10_000,
    1_000,
    30_000,
    "KUBERNETES_REQUEST_TIMEOUT_MS",
  );
  const providerTimeoutMs = integer(
    environment.WORKSPACE_PROVIDER_TIMEOUT_MS,
    30_000,
    1_000,
    60_000,
    "WORKSPACE_PROVIDER_TIMEOUT_MS",
  );
  const safeWindowMs = Math.floor(leaseDurationSeconds * 1_000 * 0.67);
  const failoverMarginMs = leaseDurationSeconds * 1_000 - safeWindowMs;
  if (failoverMarginMs < Math.max(requestTimeoutMs, providerTimeoutMs) + 1_000) {
    throw new Error("CONTROLLER_LEASE_DURATION_SECONDS must exceed dependency timeouts by a safe failover margin");
  }
  const externalSecretStoreKind = environment.EXTERNAL_SECRET_STORE_KIND ?? "ClusterSecretStore";
  if (!["ClusterSecretStore", "SecretStore"].includes(externalSecretStoreKind)) {
    throw new Error("EXTERNAL_SECRET_STORE_KIND is invalid");
  }
  return {
    port: integer(environment.PORT, 8091, 1, 65_535, "PORT"),
    kubernetesApiUrl: privateKubernetesUrl(
      required(environment.KUBERNETES_API_URL, "KUBERNETES_API_URL"),
      production,
      environment.ALLOW_INSECURE_KUBERNETES_API === "true",
    ),
    kubernetesTokenFile:
      environment.KUBERNETES_BEARER_TOKEN_FILE ??
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    namespace: dnsLabel(
      environment.PROVISIONING_WORKSPACE_NAMESPACE ?? "wasalx-tenants",
      "PROVISIONING_WORKSPACE_NAMESPACE",
    ),
    identity: token(
      required(environment.PROVISIONING_RECONCILER_IDENTITY, "PROVISIONING_RECONCILER_IDENTITY"),
      "PROVISIONING_RECONCILER_IDENTITY",
    ),
    instanceId: token(
      environment.CONTROLLER_INSTANCE_ID ?? crypto.randomUUID(),
      "CONTROLLER_INSTANCE_ID",
    ),
    leaseName: dnsLabel(
      environment.CONTROLLER_LEASE_NAME ?? "wasalx-workspace-controller",
      "CONTROLLER_LEASE_NAME",
    ),
    leaseDurationSeconds,
    pollIntervalMs,
    requestTimeoutMs,
    providerUrl,
    controlPlaneUrl,
    portalUrl,
    providerTokenFile:
      environment.WORKSPACE_PROVIDER_TOKEN_FILE ??
      "/var/run/secrets/wasalx-provider/token",
    providerTimeoutMs,
    externalSecretStoreName: dnsLabel(
      required(environment.EXTERNAL_SECRET_STORE_NAME, "EXTERNAL_SECRET_STORE_NAME"),
      "EXTERNAL_SECRET_STORE_NAME",
    ),
    externalSecretStoreKind: externalSecretStoreKind as ControllerConfig["externalSecretStoreKind"],
    baseDomain: dnsName(
      required(environment.PROVISIONING_WORKSPACE_BASE_DOMAIN, "PROVISIONING_WORKSPACE_BASE_DOMAIN"),
    ),
    ingressClassName: dnsLabel(
      required(environment.ZAMMAD_INGRESS_CLASS_NAME, "ZAMMAD_INGRESS_CLASS_NAME"),
      "ZAMMAD_INGRESS_CLASS_NAME",
    ),
    ingressNamespace: dnsLabel(
      required(environment.ZAMMAD_INGRESS_NAMESPACE, "ZAMMAD_INGRESS_NAMESPACE"),
      "ZAMMAD_INGRESS_NAMESPACE",
    ),
    clusterIssuer: dnsLabel(
      required(environment.ZAMMAD_CLUSTER_ISSUER, "ZAMMAD_CLUSTER_ISSUER"),
      "ZAMMAD_CLUSTER_ISSUER",
    ),
    storageClassName: dnsLabel(
      required(environment.ZAMMAD_STORAGE_CLASS_NAME, "ZAMMAD_STORAGE_CLASS_NAME"),
      "ZAMMAD_STORAGE_CLASS_NAME",
    ),
    secureRedis: production,
    backupEncryption: backupEncryption(environment),
    profiles: profileMap(environment.ZAMMAD_RESOURCE_PROFILES_JSON),
    backupSchedule: cron(
      environment.ZAMMAD_BACKUP_SCHEDULE ?? "0 3 * * *",
    ),
    zammadDisplayTimeZone: displayTimeZone(environment.WASALX_ZAMMAD_DISPLAY_TIMEZONE ?? wasalxTimeZone),
    allowedEgress: egress(environment.ZAMMAD_ALLOWED_EGRESS_JSON),
  };
}

export function backupEncryption(environment: NodeJS.ProcessEnv): ControllerConfig["backupEncryption"] {
  const mode = environment.ZAMMAD_BACKUP_ENCRYPTION_MODE ?? "SSE_KMS";
  if (mode === "SSE_KMS") return { mode };
  const ageRecipient = environment.ZAMMAD_BACKUP_AGE_RECIPIENT ?? "";
  if (mode !== "CLIENT_ENVELOPE" || !/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/u.test(ageRecipient)) throw new Error("Zammad backup encryption configuration is invalid");
  return { mode, ageRecipient };
}

function privateServiceUrl(raw: string, production: boolean, allowInsecure: boolean, name: string) {
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && !production && allowInsecure)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.hostname === "localhost" ||
      url.hostname.endsWith(".svc") ||
      url.hostname.endsWith(".cluster.local") ||
      /^10\.|^127\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./u.test(url.hostname)
    )
  ) {
    throw new Error(`${name} must be a private service URL`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

function publicOriginUrl(raw: string, production: boolean, allowInsecure: boolean) {
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && !production && allowInsecure)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("WASALX_PORTAL_URL must be an HTTPS origin");
  }
  url.pathname = "/";
  return url;
}

function profileMap(raw = "") {
  const fallback = {
    small: { cpu: "1", memory: "2Gi", storage: "20Gi", replicas: 1 },
    medium: { cpu: "2", memory: "4Gi", storage: "50Gi", replicas: 2 },
    large: { cpu: "4", memory: "8Gi", storage: "100Gi", replicas: 3 },
  };
  if (!raw) return fallback;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("ZAMMAD_RESOURCE_PROFILES_JSON is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ZAMMAD_RESOURCE_PROFILES_JSON is invalid");
  const result = {} as Record<"small" | "medium" | "large", ResourceProfile>;
  for (const name of ["small", "medium", "large"] as const) {
    const profile = (value as Record<string, unknown>)[name];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("ZAMMAD_RESOURCE_PROFILES_JSON is invalid");
    const entry = profile as Record<string, unknown>;
    if (
      typeof entry.cpu !== "string" ||
      typeof entry.memory !== "string" ||
      typeof entry.storage !== "string" ||
      !Number.isInteger(entry.replicas) ||
      Number(entry.replicas) < 1 ||
      Number(entry.replicas) > 10
    ) throw new Error("ZAMMAD_RESOURCE_PROFILES_JSON is invalid");
    result[name] = { cpu: entry.cpu, memory: entry.memory, storage: entry.storage, replicas: Number(entry.replicas) };
  }
  return result;
}

function egress(raw = "[]") {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("ZAMMAD_ALLOWED_EGRESS_JSON is invalid"); }
  if (!Array.isArray(value)) throw new Error("ZAMMAD_ALLOWED_EGRESS_JSON is invalid");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("ZAMMAD_ALLOWED_EGRESS_JSON is invalid");
    const item = entry as Record<string, unknown>;
    if (
      typeof item.cidr !== "string" ||
      !validCidr(item.cidr) ||
      !Array.isArray(item.ports) ||
      item.ports.length < 1 ||
      item.ports.some((port) => !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535)
    ) {
      throw new Error("ZAMMAD_ALLOWED_EGRESS_JSON is invalid");
    }
    return { cidr: item.cidr, ports: item.ports.map(Number) };
  });
}

function validCidr(value: string) {
  const match = /^([^/]+)\/(\d{1,3})$/u.exec(value);
  if (!match) return false;
  const version = isIP(match[1]);
  const prefix = Number(match[2]);
  return (version === 4 && prefix >= 1 && prefix <= 32) || (version === 6 && prefix >= 1 && prefix <= 128);
}

function cron(value: string) {
  if (value.length > 100 || value.trim().split(/\s+/u).length !== 5 || /[\r\n]/u.test(value)) throw new Error("ZAMMAD_BACKUP_SCHEDULE is invalid");
  return value.trim();
}

function displayTimeZone(value: string) {
  if (value.length > 64 || !/^[A-Za-z][A-Za-z0-9._+/-]*$/u.test(value)) {
    throw new Error("WASALX_ZAMMAD_DISPLAY_TIMEZONE is invalid");
  }
  try {
    const canonical = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
    if (canonical === value) return value;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  throw new Error("WASALX_ZAMMAD_DISPLAY_TIMEZONE is invalid");
}

function required(value: string | undefined, name: string) { if (!value) throw new Error(`${name} is required`); return value; }
function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string) { const value = raw === undefined ? fallback : Number(raw); if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`); return value; }
function dnsLabel(value: string, name: string) { if (value.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)) throw new Error(`${name} is invalid`); return value; }
function dnsName(value: string) { const normalized = value.toLowerCase().replace(/\.$/u, ""); if (normalized.length > 253 || normalized.split(".").some((part) => { try { dnsLabel(part, "domain"); return false; } catch { return true; } })) throw new Error("PROVISIONING_WORKSPACE_BASE_DOMAIN is invalid"); return normalized; }
function token(value: string, name: string) { if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) throw new Error(`${name} is invalid`); return value; }

export function readControllerToken(file: string) {
  const value = readFileSync(file, "utf8").trim();
  if (value.length < 16 || value.length > 16_384 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Controller credential is invalid");
  return value;
}
