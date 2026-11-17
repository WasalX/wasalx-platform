import path from "node:path";

export type ConfiguratorAction = "package" | "oidc" | "defaults" | "backup" | "control-backup";

type BaseConfig = {
  action: ConfiguratorAction;
  requestTimeoutMs: number;
  outputDirectory: string;
};

type TenantConfig = BaseConfig & {
  tenantId: string;
  zammadBaseUrl: URL;
};

export type PackageConfig = TenantConfig & {
  action: "package";
  zammadToken: string;
  packageVersion: string;
  packageSha256: string;
  packagePath: string;
};

export type OidcConfig = TenantConfig & {
  action: "oidc";
  zammadToken: string;
  issuer: URL;
  clientId: string;
  disablePasswordLogin: true;
};

export type DefaultsConfig = TenantConfig & {
  action: "defaults";
  zammadToken: string;
  initialGroup: string;
  retentionDays: number;
  backupPolicy: "daily-encrypted";
};

export type BackupStorageConfig = {
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  lifecycleRuleId: string;
  provider: string;
  prefix: string;
} & ({ encryptionMode: "SSE_KMS"; kmsKeyReference: string } |
  { encryptionMode: "CLIENT_ENVELOPE"; ageRecipient: string });

type DatabaseBackupConfig = BaseConfig & {
  action: "backup";
  caCertFile?: string;
  backupTimeoutMs: number;
  database: {
    url: URL;
    name: string;
  };
  region: string;
  storage: BackupStorageConfig;
};

export type TenantBackupConfig = DatabaseBackupConfig & TenantConfig & { action: "backup" };
export type ControlPlaneBackupConfig = Omit<DatabaseBackupConfig, "action"> & { action: "control-backup" };
export type BackupConfig = TenantBackupConfig | ControlPlaneBackupConfig;

export type ConfiguratorConfig = PackageConfig | OidcConfig | DefaultsConfig | BackupConfig;

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/u;
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const BUCKET = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u;
const SAFE_REFERENCE = /^(?:arn:|kms:|key:|https:\/\/|projects\/|subscriptions\/|secret:\/\/)/u;

export class ConfiguratorConfigError extends Error {
  constructor(readonly code: string) {
    super("The workspace configurator is missing required or safe configuration.");
    this.name = "ConfiguratorConfigError";
  }
}

export function loadConfiguratorConfig(
  argv = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): ConfiguratorConfig {
  const action = actionValue(argv[0]);
  const requestTimeoutMs = integer(environment.REQUEST_TIMEOUT_MS ?? "30000", 5_000, 120_000, "REQUEST_TIMEOUT_MS");
  const outputDirectory = absolutePath(environment.CONFIGURATOR_OUTPUT_DIRECTORY ?? "/var/backups/wasalx/configurator");
  const common = { action, requestTimeoutMs, outputDirectory };
  if (action === "control-backup") return loadBackupConfig(action, common, environment);

  const tenantId = required(environment, "TENANT_ID").toLowerCase();
  if (!TENANT_UUID.test(tenantId)) fail("TENANT_ID_INVALID");
  const zammadBaseUrl = serviceUrl(required(environment, "ZAMMAD_BASE_URL"), environment, "ZAMMAD_BASE_URL", tenantId);
  const base = { ...common, tenantId, zammadBaseUrl };

  if (action === "package") {
    const packageVersion = required(environment, "WASALX_PACKAGE_VERSION");
    if (packageVersion !== "0.5.84") fail("PACKAGE_VERSION_UNSUPPORTED");

    const packageSha256 = required(environment, "WASALX_PACKAGE_SHA256").toLowerCase();
    if (!SHA256.test(packageSha256)) fail("PACKAGE_SHA256_INVALID");
    return {
      ...base,
      action,
      zammadToken: credential(environment, "ZAMMAD_SERVICE_TOKEN"),
      packageVersion,
      packageSha256,
      packagePath: absolutePath(environment.WASALX_PACKAGE_PATH ?? "/app/artifacts/wasalx-0.5.84.zpm"),

    };
  }

  if (action === "oidc") {
    if (required(environment, "OIDC_DISABLE_PASSWORD_LOGIN") !== "true") fail("OIDC_PASSWORD_POLICY_INVALID");
    const clientId = required(environment, "OIDC_CLIENT_ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(clientId)) fail("OIDC_CLIENT_ID_INVALID");
    return {
      ...base,
      action,
      zammadToken: credential(environment, "ZAMMAD_SERVICE_TOKEN"),
      issuer: publicHttpsUrl(required(environment, "OIDC_ISSUER"), "OIDC_ISSUER"),
      clientId,
      disablePasswordLogin: true,
    };
  }

  if (action === "defaults") {
    const initialGroup = required(environment, "DEFAULT_ZAMMAD_GROUP");
    if (!SAFE_NAME.test(initialGroup) || /[\p{Cc}\p{Cf}]/u.test(initialGroup)) fail("DEFAULT_GROUP_INVALID");
    const backupPolicy = required(environment, "BACKUP_POLICY");
    if (backupPolicy !== "daily-encrypted") fail("BACKUP_POLICY_INVALID");
    return {
      ...base,
      action,
      zammadToken: credential(environment, "ZAMMAD_SERVICE_TOKEN"),
      initialGroup,
      retentionDays: integer(required(environment, "RETENTION_DAYS"), 1, 3_650, "RETENTION_DAYS"),
      backupPolicy,
    };
  }

  return loadBackupConfig(action, base, environment, tenantId);
}

function loadBackupConfig(
  action: "backup" | "control-backup",
  base: BaseConfig | TenantConfig,
  environment: NodeJS.ProcessEnv,
  tenantId?: string,
): BackupConfig {
  const databaseUrl = postgresUrl(required(environment, "DATABASE_URL"));
  const databaseName = required(environment, "DATABASE_NAME");
  const expectedName = tenantId ? `zammad_${tenantId.replaceAll("-", "")}` : databaseName;
  if (!DATABASE_NAME.test(databaseName) || databaseName !== expectedName || decodeURIComponent(databaseUrl.pathname.slice(1)) !== databaseName) {
    fail("DATABASE_IDENTITY_MISMATCH");
  }
  const prefix = required(environment, "OBJECT_STORAGE_PREFIX");
  const expectedPrefix = tenantId ? `tenants/${tenantId}/` : "control-plane/";
  if (prefix !== expectedPrefix || prefix.includes("..") || prefix.startsWith("/")) {
    fail("STORAGE_PREFIX_INVALID");
  }
  const bucket = required(environment, "BACKUP_S3_BUCKET");
  if (!BUCKET.test(bucket) || bucket.includes("..")) fail("STORAGE_BUCKET_INVALID");
  const encryptionMode = environment.BACKUP_ENCRYPTION_MODE ?? "SSE_KMS";
  let encryption: Pick<BackupStorageConfig, "encryptionMode"> & { kmsKeyReference?: string; ageRecipient?: string };
  if (encryptionMode === "SSE_KMS") {
    const kmsKeyReference = required(environment, "BACKUP_S3_KMS_KEY_REFERENCE");
    if (!SAFE_REFERENCE.test(kmsKeyReference) || /[\p{Cc}\p{Cf}]/u.test(kmsKeyReference)) fail("STORAGE_KMS_REFERENCE_INVALID");
    encryption = { encryptionMode, kmsKeyReference };
  } else if (encryptionMode === "CLIENT_ENVELOPE") {
    const ageRecipient = required(environment, "BACKUP_AGE_RECIPIENT");
    if (!/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/u.test(ageRecipient)) fail("STORAGE_AGE_RECIPIENT_INVALID");
    encryption = { encryptionMode, ageRecipient };
  } else fail("STORAGE_ENCRYPTION_MODE_INVALID");
  const endpoint = storageUrl(required(environment, "BACKUP_S3_ENDPOINT"), environment);
  const caCertFile = environment.BACKUP_CA_CERT_FILE;
  if (caCertFile !== undefined && (!path.posix.isAbsolute(caCertFile) || path.posix.normalize(caCertFile) !== caCertFile || /[\p{Cc}\p{Cf}]/u.test(caCertFile))) fail("BACKUP_CA_CERT_FILE_INVALID");
  if (environment.NODE_ENV === "production" && encryptionMode === "CLIENT_ENVELOPE" && !caCertFile) fail("BACKUP_CA_CERT_FILE_MISSING");
  return {
    ...base,
    action,
    ...(caCertFile ? { caCertFile } : {}),
    backupTimeoutMs: integer(environment.BACKUP_TIMEOUT_MS ?? "3000000", 60_000, 3_300_000, "BACKUP_TIMEOUT_MS"),
    database: { url: databaseUrl, name: databaseName },
    region: safeValue(required(environment, "WORKSPACE_REGION"), "WORKSPACE_REGION", 80),
    storage: {
      endpoint,
      region: safeValue(required(environment, "BACKUP_S3_REGION"), "BACKUP_S3_REGION", 80),
      bucket,
      accessKeyId: credential(environment, "BACKUP_S3_ACCESS_KEY_ID"),
      secretAccessKey: credential(environment, "BACKUP_S3_SECRET_ACCESS_KEY"),
      ...encryption,
      lifecycleRuleId: safeValue(required(environment, "BACKUP_S3_LIFECYCLE_RULE_ID"), "BACKUP_S3_LIFECYCLE_RULE_ID", 256),
      provider: safeValue(required(environment, "BACKUP_S3_PROVIDER"), "BACKUP_S3_PROVIDER", 80),
      prefix: prefix.replace(/\/$/u, ""),
    },
  } as BackupConfig;
}

function actionValue(value: string | undefined): ConfiguratorAction {
  if (value === "package" || value === "oidc" || value === "defaults" || value === "backup" || value === "control-backup") return value;
  fail("ACTION_INVALID");
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name];
  if (!value || value.trim() !== value || value.includes("\u0000") || value.includes("\r") || value.includes("\n")) {
    fail(`${name}_MISSING`);
  }
  return value;
}

function credential(environment: NodeJS.ProcessEnv, name: string) {
  const value = required(environment, name);
  if (value.length < 16 || value.length > 4_096) fail(`${name}_INVALID`);
  return value;
}

function safeValue(value: string, name: string, maximum: number) {
  if (value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) fail(`${name}_INVALID`);
  return value;
}

function integer(value: string, minimum: number, maximum: number, name: string) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(`${name}_INVALID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(`${name}_INVALID`);
  return parsed;
}

function absolutePath(value: string) {
  if (!path.isAbsolute(value) || value.includes("\u0000")) fail("PATH_INVALID");
  return path.normalize(value);
}

function serviceUrl(value: string, environment: NodeJS.ProcessEnv, name: string, tenantId: string) {
  const url = parsedUrl(value, name);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") fail(`${name}_INVALID`);
  const internalHost = `zammad-${tenantId.replaceAll("-", "")}`;
  const internal = url.protocol === "http:" && !url.port && url.hostname === internalHost;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && environment.NODE_ENV !== "production") && !internal) fail(`${name}_INSECURE`);
  return url;
}

function storageUrl(value: string, environment: NodeJS.ProcessEnv) {
  const url = parsedUrl(value, "BACKUP_S3_ENDPOINT");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("STORAGE_ENDPOINT_INVALID");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && environment.NODE_ENV !== "production")) fail("STORAGE_ENDPOINT_INSECURE");
  return url;
}

function publicHttpsUrl(value: string, name: string) {
  const url = parsedUrl(value, name);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail(`${name}_INVALID`);
  return url;
}

function postgresUrl(value: string) {
  const url = parsedUrl(value, "DATABASE_URL");
  if (!(["postgres:", "postgresql:"] as string[]).includes(url.protocol) || !url.hostname || !url.username || !url.password || url.hash) {
    fail("DATABASE_URL_INVALID");
  }
  const allowed = new Set(["sslmode"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) fail("DATABASE_URL_QUERY_INVALID");
  return url;
}

function parsedUrl(value: string, name: string) {
  try {
    return new URL(value);
  } catch {
    fail(`${name}_INVALID`);
  }
}

function fail(code: string): never {
  throw new ConfiguratorConfigError(code);
}
