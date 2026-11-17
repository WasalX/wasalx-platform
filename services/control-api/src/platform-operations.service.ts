import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { recordMetric, type MetricName } from "@wasalx/observability";
import {
  PlatformOperationsRepository,
  type PlatformTenantFilter,
  type PlatformUsageWindow,
} from "./platform-operations.repository.js";
import type { PlatformOperatorPrincipal } from "./tenant-provisioning.types.js";

@Injectable()
export class PlatformOperationsService {
  constructor(private readonly repository: PlatformOperationsRepository) {}

  metaTransitionReviewList(tenantId:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.metaTransitionReviewList(tenantId,operator,requestId));
  }
  metaTransitionReview(tenantId:string,id:string,key:string|null,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.metaTransitionReview(tenantId,id,key,operator,requestId));
  }
  metaTransitionReviewCommand(tenantId:string,id:string,action:string,key:string,body:unknown,resolve:boolean,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.metaTransitionReviewCommand(tenantId,id,action,key,body,resolve,operator,requestId));
  }

  authorizeMetaTransition(id:string,revision:number,proof:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.authorizeMetaTransition(id,revision,proof,operator,requestId));
  }
  reviewMetaTransitionTarget(id:string,observation:string,proof:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.reviewMetaTransitionTarget(id,observation,proof,operator,requestId));
  }
  authorizeMetaTransitionCompletion(id:string,revision:number,observer:string,proof:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.authorizeMetaTransitionCompletion(id,revision,observer,proof,operator,requestId));
  }

  revokeMetaArrangement(id:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.revokeMetaArrangement(id,operator,requestId));
  }
  queueMetaFundingReadback(id:string,revision:number,key:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.queueMetaFundingReadback(id,revision,key,operator,requestId));
  }

  queueMetaFundingAttachment(id:string,revision:number,key:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.queueMetaFundingAttachment(id,revision,key,operator,requestId));
  }
  registerMetaSimulatedTerms(input:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.registerMetaSimulatedTerms(input,operator,requestId));
  }

  registerMetaSimulatedRuntime(input:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.registerMetaSimulatedRuntime(input,operator,requestId));
  }
  withdrawMetaRuntime(receiptId:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.execute(()=>this.repository.withdrawMetaRuntime(receiptId,operator,requestId));
  }

  overview(operator: PlatformOperatorPrincipal, requestId: string) {
    return this.execute(() => this.repository.overview(operator, requestId));
  }

  tenants(
    filter: PlatformTenantFilter,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    return this.execute(() =>
      this.repository.tenants(filter, operator, requestId),
    );
  }

  usage(
    window: PlatformUsageWindow,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    return this.execute(() => this.repository.usage(window, operator, requestId));
  }

  rates(operator: PlatformOperatorPrincipal, requestId: string) {
    return this.execute(() => this.repository.rates(operator, requestId));
  }

  async setQuota(input: {
    tenantId: string;
    meter: string;
    period: string;
    softLimit: string;
    hardLimit?: string;
    expectedVersion?: number;
    idempotencyKey: string;
    operator: PlatformOperatorPrincipal;
    requestId: string;
  }) {
    const result = await this.execute(() =>
      this.repository.setQuota({
        ...input,
        requestSha256: operationHash({
          action: "SET_QUOTA",
          tenantId: input.tenantId,
          meter: input.meter,
          period: input.period,
          softLimit: input.softLimit,
          hardLimit: input.hardLimit ?? null,
          expectedVersion: input.expectedVersion ?? null,
        }),
      }),
    );
    safeMetric("wasalx_platform_quota_changes_total", 1, {
      meter: input.meter.toLowerCase(),
      period: input.period.toLowerCase(),
    });
    return result;
  }

  async setRate(input: {
    meter: string;
    unitPriceMicros: number;
    currency: string;
    effectiveFrom: string;
    idempotencyKey: string;
    operator: PlatformOperatorPrincipal;
    requestId: string;
  }) {
    const result = await this.execute(() =>
      this.repository.setRate({
        ...input,
        requestSha256: operationHash({
          action: "CREATE_RATE",
          meter: input.meter,
          unitPriceMicros: input.unitPriceMicros,
          currency: input.currency,
          effectiveFrom: input.effectiveFrom,
        }),
      }),
    );
    safeMetric("wasalx_platform_meter_rate_changes_total", 1, {
      meter: input.meter.toLowerCase(),
      currency: input.currency.toLowerCase(),
    });
    return result;
  }

  private async execute<T>(operation: () => Promise<T>) {
    if (!this.repository.isConfigured()) {
      throw new ServiceUnavailableException(
        "The least-privilege platform operations database role is not configured",
      );
    }
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      const code = errorCode(error);
      if (["23505", "40001", "55000"].includes(code)) {
        throw new ConflictException(
          "The platform configuration changed or the idempotency key was reused",
        );
      }
      if (code === "P0002") {
        throw new NotFoundException("The requested tenant was not found");
      }
      throw new ServiceUnavailableException(
        "The platform operations service is temporarily unavailable",
      );
    }
  }
}

export function operationHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported platform operation input");
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
}

function safeMetric(
  name: MetricName,
  value: number,
  attributes: Record<string, string>,
) {
  try {
    recordMetric(name, value, attributes);
  } catch {
    // The platform mutation is already durable. Telemetry cannot make it retry.
  }
}
