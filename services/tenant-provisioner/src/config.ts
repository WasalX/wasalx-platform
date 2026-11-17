import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export type ProvisionerConfig = {
  port: number;
  signingSecret: Uint8Array;
  kubernetesApiUrl: URL;
  kubernetesTokenFile: string;
  workspaceNamespace: string;
  reconcilerIdentity: string;
  workspaceBaseDomain: string;
  oidcIssuer: string;
  reconcileTimeoutMs: number;
  pollIntervalMs: number;
  kubernetesRequestTimeoutMs: number;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProvisionerConfig {
  const production = environment.NODE_ENV === "production";
  const signingSecret = secretValue(
    environment.PROVISIONING_DRIVER_JWT_SECRET,
    environment.PROVISIONING_DRIVER_JWT_SECRET_FILE,
  );
  if (Buffer.byteLength(signingSecret, "utf8") < 32) {
    throw new Error("PROVISIONING_DRIVER_JWT_SECRET must contain at least 32 bytes");
  }

  const kubernetesApiUrl = privateKubernetesUrl(
    required(environment.KUBERNETES_API_URL, "KUBERNETES_API_URL"),
    production,
    environment.ALLOW_INSECURE_KUBERNETES_API === "true",
  );
  const workspaceNamespace = dnsLabel(
    environment.PROVISIONING_WORKSPACE_NAMESPACE ?? "wasalx-tenants",
    "PROVISIONING_WORKSPACE_NAMESPACE",
  );
  const reconcilerIdentity = boundedToken(
    required(environment.PROVISIONING_RECONCILER_IDENTITY, "PROVISIONING_RECONCILER_IDENTITY"),
    "PROVISIONING_RECONCILER_IDENTITY",
  );
  const workspaceBaseDomain = dnsName(
    required(environment.PROVISIONING_WORKSPACE_BASE_DOMAIN, "PROVISIONING_WORKSPACE_BASE_DOMAIN"),
    "PROVISIONING_WORKSPACE_BASE_DOMAIN",
  );
  const oidcIssuerUrl = new URL(
    required(environment.PROVISIONING_OIDC_ISSUER, "PROVISIONING_OIDC_ISSUER"),
  );
  if (
    (production && oidcIssuerUrl.protocol !== "https:") ||
    !["https:", "http:"].includes(oidcIssuerUrl.protocol) ||
    oidcIssuerUrl.username ||
    oidcIssuerUrl.password ||
    oidcIssuerUrl.search ||
    oidcIssuerUrl.hash
  ) {
    throw new Error("PROVISIONING_OIDC_ISSUER must be an undecorated HTTPS URL in production");
  }
  return {
    port: integer(environment.PORT, 8090, 1, 65_535, "PORT"),
    signingSecret: new TextEncoder().encode(signingSecret),
    kubernetesApiUrl,
    kubernetesTokenFile:
      environment.KUBERNETES_BEARER_TOKEN_FILE ??
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    workspaceNamespace,
    reconcilerIdentity,
    workspaceBaseDomain,
    oidcIssuer: oidcIssuerUrl.toString().replace(/\/$/u, ""),
    reconcileTimeoutMs: integer(
      environment.PROVISIONING_RECONCILE_TIMEOUT_MS,
      45_000,
      1_000,
      110_000,
      "PROVISIONING_RECONCILE_TIMEOUT_MS",
    ),
    pollIntervalMs: integer(
      environment.PROVISIONING_POLL_INTERVAL_MS,
      1_000,
      100,
      10_000,
      "PROVISIONING_POLL_INTERVAL_MS",
    ),
    kubernetesRequestTimeoutMs: integer(
      environment.KUBERNETES_REQUEST_TIMEOUT_MS,
      10_000,
      1_000,
      30_000,
      "KUBERNETES_REQUEST_TIMEOUT_MS",
    ),
  };
}

export function privateKubernetesUrl(
  raw: string,
  production: boolean,
  allowInsecureDevelopment = false,
) {
  const url = new URL(raw);
  const protocolAllowed =
    url.protocol === "https:" ||
    (!production && allowInsecureDevelopment && url.protocol === "http:");
  if (
    !protocolAllowed ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    !privateHost(url.hostname)
  ) {
    throw new Error("KUBERNETES_API_URL must be a private, undecorated Kubernetes API URL");
  }
  url.pathname = "/";
  return url;
}

function privateHost(host: string) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "kubernetes.default" ||
    normalized.endsWith(".svc") ||
    normalized.endsWith(".svc.cluster.local") ||
    normalized.endsWith(".cluster.local")
  ) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return version === 6 && (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd"));
}

function secretValue(raw: string | undefined, file: string | undefined) {
  if (raw && file) {
    throw new Error("Set only one provisioning JWT secret source");
  }
  if (file) return readFileSync(file, "utf8").trimEnd();
  return required(raw, "PROVISIONING_DRIVER_JWT_SECRET or its file variant");
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function dnsLabel(value: string, name: string) {
  if (
    value.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  ) {
    throw new Error(`${name} must be a DNS label`);
  }
  return value;
}

function dnsName(value: string, name: string) {
  const normalized = value.toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length > 253 ||
    normalized.split(".").some((label) => {
      try {
        dnsLabel(label, name);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error(`${name} must be a DNS name`);
  }
  return normalized;
}

function boundedToken(value: string, name: string) {
  if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
