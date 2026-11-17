import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import type { PlatformOperatorPrincipal } from "./tenant-provisioning.types.js";
import type {MetaRoutingOperatorDto,MetaRoutingReviewResult} from '@wasalx/core/meta-routing-contract';

export type PlatformTenantFilter = {
  state?: string;
  query?: string;
  limit: number;
  cursor?: string;
};

export type PlatformUsageWindow = {
  tenantId: string;
  from: string;
  to: string;
};

@Injectable()
export class PlatformOperationsRepository implements OnModuleDestroy {
  private readonly pool?: Pool;

  constructor() {
    const connectionString = process.env.PLATFORM_OPERATIONS_DATABASE_URL;
    if (!connectionString) return;
    this.pool = new Pool({
      connectionString,
      options: "-c role=wasalx_platform_operations_client",
      max: boundedInteger(
        process.env.PLATFORM_OPERATIONS_DATABASE_POOL_SIZE,
        4,
        1,
        10,
      ),
      statement_timeout: 15_000,
      application_name: "wasalx-platform-operations-api",
    });
  }

  isConfigured() {
    return Boolean(this.pool);
  }

  async metaManagedApprovalContext(tenantId:string,accountId:string,operator:PlatformOperatorPrincipal,requestId:string):Promise<{appId:string;phoneNumberId:string;bindingId:string;bindingRevision:number;authorityRevision:number;proofSha256:string}>{
    void operator;void requestId;
    const value=await this.jsonFunction("SELECT app.operator_meta_managed_approval_context($1,$2) result",[tenantId,accountId]);
    if(typeof value.appId!=="string"||typeof value.phoneNumberId!=="string"||typeof value.bindingId!=="string"||typeof value.proofSha256!=="string"
      ||typeof value.bindingRevision!=="number"||!Number.isSafeInteger(value.bindingRevision)
      ||typeof value.authorityRevision!=="number"||!Number.isSafeInteger(value.authorityRevision))throw new Error("Account approval context is unavailable");
    return{appId:value.appId,phoneNumberId:value.phoneNumberId,bindingId:value.bindingId,bindingRevision:value.bindingRevision,authorityRevision:value.authorityRevision,proofSha256:value.proofSha256};
  }
  async approveMetaSimulatedArrangement(input:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_approve_meta_simulated_arrangement($1,$2,$3) result",[input,operator.subject,requestId]);
  }
  async metaTransitionReviewList(tenantId:string,operator:PlatformOperatorPrincipal,requestId:string){
    void operator;void requestId;
    return this.jsonFunction("SELECT app.operator_meta_transition_list($1) AS result",[tenantId]);
  }
  async metaTransitionReview(tenantId:string,id:string,key:string|null,operator:PlatformOperatorPrincipal,requestId:string){
    void requestId;
    return this.jsonFunction("SELECT app.operator_meta_transition_review($1,$2,$3,$4) AS result",[tenantId,id,operator.subject,key]);
  }
  async metaTransitionReviewCommand(tenantId:string,id:string,action:string,key:string,body:unknown,resolve:boolean,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_meta_transition_command($1,$2,$3,$4,$5::jsonb,$6,$7,$8) AS result",
      [tenantId,id,action,key,JSON.stringify(body),operator.subject,requestId,resolve]);
  }

  async authorizeMetaTransition(id:string,revision:number,proof:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_authorize_meta_transition($1,$2,$3::jsonb,$4,$5) AS result",[id,revision,JSON.stringify(proof),operator.subject,requestId]);
  }
  async reviewMetaTransitionTarget(id:string,observation:string,proof:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_review_meta_transition_target($1,$2,$3::jsonb,$4,$5) AS result",[id,observation,JSON.stringify(proof),operator.subject,requestId]);
  }
  async authorizeMetaTransitionCompletion(id:string,revision:number,observer:string,proof:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_authorize_meta_transition_completion($1,$2,$3,$4::jsonb,$5,$6) AS result",[id,revision,observer,JSON.stringify(proof),operator.subject,requestId]);
  }

  async revokeMetaArrangement(id:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_revoke_meta_arrangement($1,$2,$3) result",[id,operator.subject,requestId]);
  }
  async queueMetaFundingReadback(id:string,revision:number,key:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_queue_meta_funding_readback($1,$2,$3,$4,$5) result",[id,revision,key,operator.subject,requestId]);
  }

  async queueMetaFundingAttachment(id:string,revision:number,key:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_queue_meta_funding_attachment($1,$2,$3,$4,$5) result",[id,revision,key,operator.subject,requestId]);
  }
  async registerMetaSimulatedTerms(input:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_register_meta_simulated_terms($1,$2,$3) AS result",[input,operator.subject,requestId]);
  }

  async registerMetaSimulatedRuntime(input:unknown,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_register_meta_simulated_runtime($1,$2,$3) AS result",[input,operator.subject,requestId]);
  }
  async withdrawMetaRuntime(receiptId:string,operator:PlatformOperatorPrincipal,requestId:string){
    return this.jsonFunction("SELECT app.operator_withdraw_meta_runtime($1,$2,$3) AS result",[receiptId,operator.subject,requestId]);
  }

  async metaDeletionReceipts(operator:PlatformOperatorPrincipal,requestId:string,cursor?:string,locator?:string) {
    return this.jsonFunction("SELECT app.operator_meta_deletion_receipts($1,$2,$3,$4) AS result",[operator.subject,requestId,cursor??null,locator??null]);
  }
  async reviewMetaDeletionReceipt(input:{id:string;key:string;expectedVersion:number;state:string;reason:string;evidenceSha256:string;refusalPolicyUrl?:string;operator:PlatformOperatorPrincipal;requestId:string}) {
    return this.jsonFunction("SELECT app.operator_review_meta_deletion_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",[input.id,input.expectedVersion,input.state,input.reason,input.evidenceSha256,input.key,input.operator.subject,input.requestId,input.refusalPolicyUrl??null]);
  }

  async overview(operator: PlatformOperatorPrincipal, requestId: string) {
    return this.jsonFunction(
      "SELECT app.operator_platform_operations_overview($1,$2) AS result",
      [operator.subject, requestId],
    );
  }

  async tenants(
    filter: PlatformTenantFilter,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    return this.jsonFunction(
      "SELECT app.operator_list_tenant_operations($1,$2,$3,$4,$5,$6) AS result",
      [
        operator.subject,
        requestId,
        filter.state ?? null,
        filter.query ?? null,
        filter.limit,
        filter.cursor ?? null,
      ],
    );
  }

  async usage(
    window: PlatformUsageWindow,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    return this.jsonFunction(
      "SELECT app.operator_tenant_metering_summary($1,$2,$3,$4,$5) AS result",
      [window.tenantId, window.from, window.to, operator.subject, requestId],
    );
  }

  async rates(operator: PlatformOperatorPrincipal, requestId: string) {
    return this.jsonFunction(
      "SELECT app.operator_list_meter_rates($1,$2) AS result",
      [operator.subject, requestId],
    );
  }

  async setQuota(input: {
    tenantId: string;
    meter: string;
    period: string;
    softLimit: string;
    hardLimit?: string;
    expectedVersion?: number;
    idempotencyKey: string;
    requestSha256: string;
    operator: PlatformOperatorPrincipal;
    requestId: string;
  }) {
    return this.jsonFunction(
      "SELECT app.operator_set_tenant_meter_quota($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
      [
        input.tenantId,
        input.meter,
        input.period,
        input.softLimit,
        input.hardLimit ?? null,
        input.expectedVersion ?? null,
        input.idempotencyKey,
        input.requestSha256,
        input.operator.subject,
        input.requestId,
      ],
    );
  }

  async setRate(input: {
    meter: string;
    unitPriceMicros: number;
    currency: string;
    effectiveFrom: string;
    idempotencyKey: string;
    requestSha256: string;
    operator: PlatformOperatorPrincipal;
    requestId: string;
  }) {
    return this.jsonFunction(
      "SELECT app.operator_create_meter_rate($1,$2,$3,$4,$5,$6,$7,$8) AS result",
      [
        input.meter,
        input.unitPriceMicros,
        input.currency,
        input.effectiveFrom,
        input.idempotencyKey,
        input.requestSha256,
        input.operator.subject,
        input.requestId,
      ],
    );
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  async metaRoutingReview(input:{tenantId:string;connectionId:string;operator:PlatformOperatorPrincipal;requestId:string}){
    return await this.jsonFunction("SELECT app.operator_meta_routing_review($1,$2,$3,$4) AS result",[input.tenantId,input.connectionId,input.operator.subject,input.requestId]) as MetaRoutingOperatorDto;
  }
  async recordMetaRoutingReview(input:{tenantId:string;connectionId:string;body:unknown;appId:string;runtime:unknown;key:string;hash:string;operator:PlatformOperatorPrincipal;requestId:string}){
    return await this.jsonFunction("SELECT app.operator_record_meta_routing_review($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,$9) AS result",
      [input.tenantId,input.connectionId,JSON.stringify(input.body),input.appId,JSON.stringify(input.runtime),input.key,input.hash,input.operator.subject,input.requestId]) as MetaRoutingReviewResult;
  }

  metaCostAction(input: { action: string; tenantId: string; objectId: string | null; body: unknown; idempotencyKey: string; operator: PlatformOperatorPrincipal; requestId: string }) {
    return this.jsonFunction("SELECT app.operator_meta_cost($1,$2,$3,$4::jsonb,$5,$6,$7) AS result", [
      input.action, input.tenantId, input.objectId, JSON.stringify(input.body), input.idempotencyKey, input.operator.subject, input.requestId,
    ]);
  }

  metaCostRead(input: { tenantId: string; accountId: string | null; from: string; to: string; operator: PlatformOperatorPrincipal; requestId: string }) {
    return this.jsonFunction("SELECT app.operator_meta_cost_read($1,$2,$3,$4,$5,$6) AS result", [
      input.tenantId, input.accountId, input.from, input.to, input.operator.subject, input.requestId,
    ]);
  }

  metaStatementAction(input: { action:string;tenantId:string;objectId:string|null;body:unknown;idempotencyKey:string;operator:PlatformOperatorPrincipal;requestId:string }) {
    return this.jsonFunction("SELECT app.operator_meta_statement($1,$2,$3,$4::jsonb,$5,$6,$7) AS result",[
      input.action,input.tenantId,input.objectId,JSON.stringify(input.body),input.idempotencyKey,input.operator.subject,input.requestId,
    ]);
  }

  metaStatementRead(input: { tenantId:string;accountId:string|null;id:string|null;from:string|null;to:string|null;operator:PlatformOperatorPrincipal;requestId:string }) {
    return this.jsonFunction("SELECT app.operator_meta_statement_read($1,$2,$3,$4,$5,$6,$7) AS result",[
      input.tenantId,input.accountId,input.id,input.from,input.to,input.operator.subject,input.requestId,
    ]);
  }

  private async jsonFunction(sql: string, values: unknown[]) {
    const result = await this.requiredPool().query<{ result: unknown }>(
      sql,
      values,
    );
    const value = result.rows[0]?.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Platform operation returned no result");
    }
    return value as Record<string, unknown>;
  }

  private requiredPool() {
    if (!this.pool) {
      throw new Error(
        "PLATFORM_OPERATIONS_DATABASE_URL for the execution-only platform role is required",
      );
    }
    return this.pool;
  }
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Platform operations database pool size must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
