import type { FastifyRequest } from "fastify";

export const tenantProvisioningSteps = [
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

export type TenantProvisioningStep = (typeof tenantProvisioningSteps)[number];
export type TenantProvisioningAction = "PROVISION" | "SUSPEND" | "RESUME";
export type TenantResumePhase = "PREPARE" | "PUBLISH";

export type TenantProvisioningRelease = {
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

export type PlatformOperatorPrincipal = {
  subject: string;
  email: string;
  displayName: string;
  authenticatedAt: number;
};

export type PlatformOperatorRequest = FastifyRequest & {
  platformOperator: PlatformOperatorPrincipal;
};

export type TenantProvisioningCreateSpec = {
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
  };
};

export type TenantProvisioningSpec = Omit<TenantProvisioningCreateSpec, "deployment"> & {
  deployment: TenantProvisioningCreateSpec["deployment"] & {
    release: TenantProvisioningRelease;
  };
};

export type TenantProvisioningTask = {
  operationId: string;
  zammadInstanceId: string;
  tenantId: string;
  action: TenantProvisioningAction;
  status: string;
  completedSteps: TenantProvisioningStep[];
  currentStep: TenantProvisioningStep | "resume_prepare" | "resume_publish" | null;
  stepResults: Record<string, unknown>;
  spec: TenantProvisioningSpec;
  attempts: number;
  maxAttempts: number;
  fencingToken: number;
};

export type TenantProvisioningDriverRequest = {
  version: 1;
  operationId: string;
  zammadInstanceId: string;
  tenantId: string;
  action: TenantProvisioningAction;
  step?: TenantProvisioningStep;
  resumePhase?: TenantResumePhase;
  fencingToken: number;
  idempotencyKey: string;
  spec: TenantProvisioningSpec;
  completedSteps: TenantProvisioningStep[];
  priorResults: Record<string, unknown>;
};

export type TenantProvisioningDriverResult = {
  status: "SUCCEEDED";
  operationId: string;
  zammadInstanceId: string;
  tenantId: string;
  action: TenantProvisioningAction;
  step?: TenantProvisioningStep;
  resumePhase?: TenantResumePhase;
  fencingToken: number;
  idempotencyKey: string;
  outputs: Record<string, unknown>;
};
