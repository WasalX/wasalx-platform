export const provisioningSteps = [
  "identity",
  "database",
  "search",
  "storage",
  "secrets",
  "zammad",
  "package",
  "oidc",
  "defaults",
  "health",
] as const;

export type ProvisioningStep = (typeof provisioningSteps)[number];
export type ProvisioningAction = "PROVISION" | "SUSPEND" | "RESUME";
export type ResumePhase = "PREPARE" | "PUBLISH";

export type TenantProvisioningSpec = {
  tenant: {
    name: string;
    slug: string;
    retentionDays: number;
  };
  owner: {
    oidcSubject: string;
    email: string;
    displayName: string;
  };
  deployment: {
    region: string;
    resourceProfile: "small" | "medium" | "large";
    zammadVersion: string;
    release: {
      packageVersion: string;
      packageSha256: string;
      images: {
        zammad: string;
        configurator: string;
        nginx: string;
        redis: string;
        memcached: string;
      };
    };
  };
};

export type TenantProvisioningRequest = {
  version: 1;
  operationId: string;
  zammadInstanceId: string;
  tenantId: string;
  action: ProvisioningAction;
  step?: ProvisioningStep;
  resumePhase?: ResumePhase;
  fencingToken: number;
  idempotencyKey: string;
  spec: TenantProvisioningSpec;
  completedSteps: ProvisioningStep[];
  priorResults: Record<string, unknown>;
};

export type TenantProvisioningResult = {
  status: "SUCCEEDED";
  operationId: string;
  zammadInstanceId: string;
  tenantId: string;
  action: ProvisioningAction;
  step?: ProvisioningStep;
  resumePhase?: ResumePhase;
  fencingToken: number;
  idempotencyKey: string;
  outputs: Record<string, unknown>;
};

export type WorkspaceCondition = {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  observedGeneration?: number;
};

export type TenantWorkspace = {
  apiVersion: "platform.wasalx.io/v1alpha1";
  kind: "TenantWorkspace";
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    generation?: number;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: WorkspaceSpec;
  status?: {
    observedGeneration?: number;
    observedFencingToken?: number;
    lastAppliedIdempotencyKey?: string;
    reconciler?: string;
    conditions?: WorkspaceCondition[];
    outputs?: Partial<Record<ProvisioningStep | "suspend" | "resume_prepare" | "resume", Record<string, unknown>>>;
  };
};

export type WorkspaceSpec = {
  tenantId: string;
  displayName: string;
  slug: string;
  region: string;
  resourceProfile: "small" | "medium" | "large";
  retentionDays: number;
  owner: {
    oidcSubject: string;
    email: string;
    displayName: string;
  };
  request: {
    operationId: string;
    action: ProvisioningAction;
    desiredStep: ProvisioningStep | "suspend" | "resume_prepare" | "resume_publish";
    resumePhase?: ResumePhase;
    fencingToken: number;
    idempotencyKey: string;
    completedSteps: ProvisioningStep[];
  };
  database: {
    isolation: "DedicatedDatabaseAndRole";
    databaseName: string;
    roleName: string;
    secretReference: string;
  };
  search: {
    isolation: "DedicatedNamespaceAndCredential";
    namespace: string;
    secretReference: string;
  };
  storage: {
    isolation: "DedicatedPrefixAndCredential";
    prefix: string;
    secretReference: string;
  };
  secrets: {
    serviceSecretReference: string;
    privacySecretReference: string;
  };
  zammad: {
    instanceId: string;
    version: string;
    image: string;
    configuratorImage: string;
    nginxImage: string;
    redisImage: string;
    memcachedImage: string;
    hostname: string;
    packageVersion: string;
    packageSha256: string;
  };
  oidc: {
    issuer: string;
    clientId: string;
    secretReference: string;
    disablePasswordLogin: true;
  };
  defaults: {
    initialGroup: "Operations";
    backupPolicy: "daily-encrypted";
    retentionDays: number;
  };
  desiredState: "Active" | "Suspended";
};

export class ProvisionerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
    readonly retryable = false,
  ) {
    super(safeMessage);
    this.name = "ProvisionerError";
  }
}
