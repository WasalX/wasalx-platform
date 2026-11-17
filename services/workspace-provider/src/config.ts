export type WorkspaceProviderConfig = {
  port: number;
  databaseUrl: string;
  tokenFile: string;
  kubernetesApiUrl: URL;
  kubernetesTokenFile: string;
  kubernetesCaFile: string;
  namespace: string;
  fieldManager: string;
  requestTimeoutMs: number;
  tlsCertFile: string;
  tlsKeyFile: string;
  operatorDeployments: Record<"identity" | "database" | "search" | "storage" | "secrets", string>;
};

export function loadWorkspaceProviderConfig(environment: NodeJS.ProcessEnv = process.env): WorkspaceProviderConfig {
  const kubernetesApiUrl = new URL(required(environment.KUBERNETES_API_URL, "KUBERNETES_API_URL"));
  if (kubernetesApiUrl.protocol !== "https:" || kubernetesApiUrl.username || kubernetesApiUrl.password || kubernetesApiUrl.search || kubernetesApiUrl.hash) {
    throw new Error("KUBERNETES_API_URL must be a credential-free HTTPS URL");
  }
  const namespace = dns(required(environment.WORKSPACE_PROVIDER_NAMESPACE, "WORKSPACE_PROVIDER_NAMESPACE"));
  const fieldManager = bounded(required(environment.WORKSPACE_PROVIDER_FIELD_MANAGER, "WORKSPACE_PROVIDER_FIELD_MANAGER"), 3, 128);
  return {
    port: integer(environment.PORT, 8092, 1, 65_535, "PORT"),
    databaseUrl: required(environment.WORKSPACE_PROVIDER_DATABASE_URL, "WORKSPACE_PROVIDER_DATABASE_URL"),
    tokenFile: required(environment.WORKSPACE_PROVIDER_TOKEN_FILE, "WORKSPACE_PROVIDER_TOKEN_FILE"),
    kubernetesApiUrl,
    kubernetesTokenFile: required(environment.KUBERNETES_TOKEN_FILE, "KUBERNETES_TOKEN_FILE"),
    kubernetesCaFile: required(environment.KUBERNETES_CA_FILE, "KUBERNETES_CA_FILE"),
    namespace,
    fieldManager,
    requestTimeoutMs: integer(environment.WORKSPACE_PROVIDER_REQUEST_TIMEOUT_MS, 10_000, 1_000, 60_000, "WORKSPACE_PROVIDER_REQUEST_TIMEOUT_MS"),
    tlsCertFile: required(environment.WORKSPACE_PROVIDER_TLS_CERT_FILE, "WORKSPACE_PROVIDER_TLS_CERT_FILE"),
    tlsKeyFile: required(environment.WORKSPACE_PROVIDER_TLS_KEY_FILE, "WORKSPACE_PROVIDER_TLS_KEY_FILE"),
    operatorDeployments: operators(required(environment.WORKSPACE_PROVIDER_OPERATOR_DEPLOYMENTS_JSON, "WORKSPACE_PROVIDER_OPERATOR_DEPLOYMENTS_JSON")),
  };
}

export function loadMigrationDatabaseUrl(environment: NodeJS.ProcessEnv = process.env) {
  return required(environment.WORKSPACE_PROVIDER_MIGRATION_DATABASE_URL, "WORKSPACE_PROVIDER_MIGRATION_DATABASE_URL");
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function bounded(value: string, minimum: number, maximum: number) {
  if (value.length < minimum || value.length > maximum || /[\p{Cc}\p{Cf}\s]/u.test(value)) throw new Error("configuration token is invalid");
  return value;
}
function dns(value: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) throw new Error("WORKSPACE_PROVIDER_NAMESPACE is invalid");
  return value;
}
function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function operators(raw: string): WorkspaceProviderConfig["operatorDeployments"] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("WORKSPACE_PROVIDER_OPERATOR_DEPLOYMENTS_JSON is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WORKSPACE_PROVIDER_OPERATOR_DEPLOYMENTS_JSON is invalid");
  const record = value as Record<string, unknown>;
  const keys = ["identity", "database", "search", "storage", "secrets"] as const;
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key as typeof keys[number]))) throw new Error("WORKSPACE_PROVIDER_OPERATOR_DEPLOYMENTS_JSON is invalid");
  return Object.fromEntries(keys.map((key) => [key, dns(String(record[key]))])) as WorkspaceProviderConfig["operatorDeployments"];
}
