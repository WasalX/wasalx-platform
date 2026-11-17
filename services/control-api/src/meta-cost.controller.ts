import { BadRequestException, Body, ConflictException, Controller, Get, Headers, NotFoundException, Param, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { metaCostSha256, metaCostTimestamp, metaCostUuid, parseMetaCostSelectorEvidence, parseMetaCostTariff, parseMetaCostStatement, parseMetaCostFinanceRetention, type MetaCostUsageSnapshot } from "@wasalx/core/meta-cost";
import { appendAudit } from "./audit.js";
import { csvCell } from "./audit.controller.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { PlatformOperatorGuard, PlatformOperatorOnly, SkipTenantAuthentication } from "./platform-operator-auth.js";
import { PlatformOperationsRepository } from "./platform-operations.repository.js";
import type { PlatformOperatorRequest } from "./tenant-provisioning.types.js";
import type { AuthenticatedRequest } from "./types.js";
import { TenantDrainService } from "./tenant-drain.service.js";

@Controller("v1/meta/costs")
export class MetaCostController {
  constructor(private readonly database: DatabaseService) {}

  @Get("accounts")
  @Requires("billing:read")
  async accounts(@Req() request: AuthenticatedRequest) {
    const result = await this.database.rows<{ accounts: Array<{id:string;names:string[]}> }>(request.principal.tenantId,
      "SELECT app.meta_cost_accounts($1) AS accounts", [request.principal.tenantId]);
    const rows=result[0]?.accounts??[];
    if (rows.length > 100) throw new ConflictException("The account selection is too large");
    return rows;
  }

  @Get("usage")
  @Requires("billing:read")
  usage(@Req() request: AuthenticatedRequest, @Query("accountId") account?: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.snapshot(request, parseCostWindow(account, from, to), false);
  }

  @Get("export")
  @Requires("billing:export")
  async export(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply, @Query("accountId") account?: string, @Query("from") from?: string, @Query("to") to?: string) {
    const window = parseCostWindow(account, from, to);
    const result = await this.snapshot(request, window, true);
    reply.header("cache-control", "private, no-store").header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="wasalx-meta-costs-${window.from.slice(0, 10)}-${window.to.slice(0, 10)}.csv"`)
      .header("x-content-type-options", "nosniff").send(metaCostCsv(result));
  }

  private snapshot(request: AuthenticatedRequest, window: ReturnType<typeof parseCostWindow>, exporting: boolean) {
    return this.database.withTenant(request.principal.tenantId, async client => {
      const result = (await client.query<{ result: MetaCostUsageSnapshot }>(
        "SELECT app.meta_cost_usage_snapshot($1,$2,$3,$4) AS result", [request.principal.tenantId, window.accountId, window.from, window.to],
      )).rows[0]?.result;
      if (!result?.complete) throw new ConflictException("Choose a shorter period to retrieve complete usage");
      // Validate the bounded export before recording a successful export event.
      if (exporting) metaCostCsv(result);
      await appendAudit(client, request.principal, {
        action: exporting ? "meta.cost.exported" : "meta.cost.viewed", targetType: "meta_cost", targetId: window.accountId ?? "unattributed",
        requestId: String(request.id), newValue: { from: window.from, to: window.to, selectedCount: result.selectedCount, selectedSha256: result.selectedSha256 },
      });
      return result;
    });
  }

  @Get("statements")
  @Requires("billing:read")
  statements(@Req() request:AuthenticatedRequest,@Query("accountId") account?:string,@Query("from") from?:string,@Query("to") to?:string){
    return this.statementRows(request,parseCostWindow(account,from,to),false);
  }

  @Get("statements/export")
  @Requires("billing:export")
  async exportStatements(@Req() request:AuthenticatedRequest,@Res() reply:FastifyReply,@Query("accountId") account?:string,@Query("from") from?:string,@Query("to") to?:string){
    const rows=await this.statementRows(request,parseCostWindow(account,from,to),true);
    const csv=metaCostStatementCsv(rows);
    reply.header("cache-control","private, no-store").header("content-type","text/csv; charset=utf-8").header("x-content-type-options","nosniff")
      .header("content-disposition",'attachment; filename="wasalx-cost-statements.csv"').send(csv);
  }

  @Get("statements/:statementId")
  @Requires("billing:read")
  async statement(@Req() request:AuthenticatedRequest,@Param("statementId") statementId:string){
    const id=input(()=>metaCostUuid(statementId));
    return this.database.withTenant(request.principal.tenantId,async client=>{
      const result=(await client.query<{value:unknown}>("SELECT app.meta_cost_statement_publication($1,$2) AS value",[request.principal.tenantId,id])).rows[0]?.value;
      if(!result)throw new NotFoundException("Published statement was not found");
      await appendAudit(client,request.principal,{action:"meta.statement.viewed",targetType:"meta_cost_statement",targetId:id,requestId:String(request.id)});
      return result;
    });
  }

  private statementRows(request:AuthenticatedRequest,window:ReturnType<typeof parseCostWindow>,exporting:boolean){
    if(!window.accountId)throw new BadRequestException("Choose a messaging account");
    return this.database.withTenant(request.principal.tenantId,async client=>{
      const rows=(await client.query<{value:Array<Record<string,unknown>>}>("SELECT app.meta_cost_statement_summaries($1,$2,$3,$4) AS value",
        [request.principal.tenantId,window.accountId,window.from,window.to])).rows[0]?.value??[];
      if(rows.length>1000)throw new ConflictException("Choose a shorter statement period");
      if(exporting)metaCostStatementCsv(rows);
      await appendAudit(client,request.principal,{action:exporting?"meta.statement.exported":"meta.statements.viewed",targetType:"meta_cost_statement",
        targetId:window.accountId!,requestId:String(request.id),newValue:{count:rows.length,from:window.from,to:window.to}});
      return rows;
    });
  }
}

export function metaCostStatementCsv(rows:Array<Record<string,unknown>>){
  if(rows.length>1000)throw new ConflictException("Choose a shorter statement period");
  const fields=["rowType","id","purpose","basisKind","evidenceMode","currency","periodFrom","periodTo","amount","estimatedAmount","difference","quantity","coverage","publishedAt","predecessorId","superseded","publicationSha256","sourceAvailability","adjustmentStatementId","adjustmentAmount","adjustmentTreatment"];
  const records:Array<Record<string,unknown>>=[];
  for(const row of rows){
    records.push({...row,rowType:"STATEMENT"});
    const adjustments=Array.isArray(row.adjustments)?row.adjustments as Array<Record<string,unknown>>:[];
    if(adjustments.length>1000||records.length+adjustments.length>10000)throw new ConflictException("Statement breakdown is too large");
    for(const adjustment of adjustments)records.push({id:row.id,rowType:"ADJUSTMENT",purpose:row.purpose,basisKind:row.basisKind,evidenceMode:row.evidenceMode,
      currency:row.currency,periodFrom:row.periodFrom,periodTo:row.periodTo,publicationSha256:row.publicationSha256,
      adjustmentStatementId:adjustment.statementVersionId,adjustmentAmount:adjustment.amount,adjustmentTreatment:adjustment.treatment});
  }
  const csv=`\uFEFF${[fields,...records.map(row=>fields.map(field=>row[field]))].map(row=>row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  if(Buffer.byteLength(csv,"utf8")>10_485_760)throw new ConflictException("Statement export is too large");
  return csv;
}

@Controller("platform/v1/meta-costs")
@SkipTenantAuthentication()
@PlatformOperatorOnly()
@UseGuards(PlatformOperatorGuard)
export class PlatformMetaCostController {
  constructor(private readonly operations: PlatformOperationsRepository,private readonly drain:TenantDrainService) {}

  @Get("tenants/:tenantId")
  read(@Req() request: PlatformOperatorRequest, @Param("tenantId") tenantId: string, @Query("accountId") account?: string, @Query("from") from?: string, @Query("to") to?: string) {
    const scope = input(() => ({ tenantId: metaCostUuid(tenantId), ...parseCostWindow(account, from, to) }));
    return this.execute(() => this.operations.metaCostRead({ ...scope, operator: request.platformOperator, requestId: String(request.id) }));
  }

  @Get("tenants/:tenantId/export")
  async export(@Req() request: PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Res() reply:FastifyReply,
    @Query("accountId") account?:string,@Query("from") from?:string,@Query("to") to?:string){
    const result=await this.read(request,tenantId,account,from,to) as MetaCostUsageSnapshot;
    reply.header("cache-control","private, no-store").header("content-type","text/csv; charset=utf-8")
      .header("x-content-type-options","nosniff").header("content-disposition",'attachment; filename="wasalx-meta-costs.csv"').send(metaCostCsv(result));
  }

  @Post("tenants/:tenantId/tariffs")
  draft(@Req() request: PlatformOperatorRequest, @Param("tenantId") tenantId: string, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const parsed = input(() => {
      const value = object(body, ["definition", "supersedesId"]), definition = parseMetaCostTariff(value.definition);
      if (definition.tenantId !== metaCostUuid(tenantId)) throw new Error("Tariff tenant mismatch");
      return { definition, supersedesId: value.supersedesId === null ? null : metaCostUuid(value.supersedesId) };
    });
    return this.action(request, "META_COST_DRAFT", tenantId, null, parsed, key);
  }

  @Post("tenants/:tenantId/tariffs/:tariffId/activate")
  activate(@Req() request: PlatformOperatorRequest, @Param("tenantId") tenantId: string, @Param("tariffId") tariffId: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const parsed = input(() => {
      const value = object(body, ["expectedDefinitionSha256", "policyVersionId"]);
      return { expectedDefinitionSha256: metaCostSha256(value.expectedDefinitionSha256), policyVersionId: value.policyVersionId === null ? null : metaCostUuid(value.policyVersionId) };
    });
    return this.action(request, "META_COST_ACTIVATE", tenantId, input(() => metaCostUuid(tariffId)), parsed, key);
  }

  @Post("tenants/:tenantId/accounts/:accountId/reassess")
  reassess(@Req() request: PlatformOperatorRequest, @Param("tenantId") tenantId: string, @Param("accountId") accountId: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const parsed = input(() => {
      const value = object(body, ["purpose", "items"]);
      if (!["UPSTREAM_REFERENCE", "CUSTOMER_TARIFF"].includes(String(value.purpose)) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) throw new Error("Invalid reassessment scope");
      const items = value.items.map(raw => {
        const hasSelector=Boolean(raw&&typeof raw==="object"&&Object.hasOwn(raw,"selectorEvidence"));
        const item = object(raw, hasSelector?["deliveryId", "expectedHeadId", "selectorEvidence"]:["deliveryId","expectedHeadId"]);
        return { deliveryId: metaCostUuid(item.deliveryId), expectedHeadId: metaCostUuid(item.expectedHeadId),
          ...(hasSelector?{selectorEvidence: item.selectorEvidence === null ? null : parseMetaCostSelectorEvidence(item.selectorEvidence)}:{}) };
      });
      if (new Set(items.map(item => item.deliveryId)).size !== items.length) throw new Error("Duplicate effect");
      return { purpose: value.purpose, items };
    });
    return this.action(request, "META_COST_REASSESS", tenantId, input(() => metaCostUuid(accountId)), parsed, key);
  }

  private action(request: PlatformOperatorRequest, action: string, tenantId: string, objectId: string | null, body: unknown, key: string | undefined) {
    const scope = input(() => {
      if (!key || key.length > 255 || key.trim() !== key || /[\p{Cc}\p{Cf}]/u.test(key)) throw new Error("A valid idempotency key is required");
      return { tenantId: metaCostUuid(tenantId), idempotencyKey: key };
    });
    return this.execute(() => this.operations.metaCostAction({ ...scope, action, objectId, body, operator: request.platformOperator, requestId: String(request.id) }));
  }

  private async execute<T>(operation: () => Promise<T>) {
    if (!this.operations.isConfigured()) throw new ServiceUnavailableException("Platform operations are unavailable");
    try { return await operation(); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (["23505", "40001", "55000", "54000"].includes(code)) throw new ConflictException("Cost evidence changed or requires a narrower scope; reload before continuing");
      if (["22023", "22P02", "22007", "22008", "23514"].includes(code)) throw new BadRequestException("The cost request is invalid");
      if (code === "P0002") throw new NotFoundException("Cost evidence was not found");
      throw new ServiceUnavailableException("Cost evidence is temporarily unavailable");
    }
  }

  @Post("tenants/:tenantId/statements")
  reserveStatement(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.statementAction(request,"META_STATEMENT_RESERVE",tenantId,null,input(()=>parseMetaCostStatement(body)),key);
  }

  @Post("tenants/:tenantId/finance-retention")
  financeRetention(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.statementAction(request,"META_FINANCE_RETENTION",tenantId,null,input(()=>parseMetaCostFinanceRetention(body)),key);
  }

  @Get("tenants/:tenantId/statements")
  async statements(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Query("accountId") account?:string,@Query("from") from?:string,@Query("to") to?:string){
    const window=parseCostWindow(account,from,to);
    if(!window.accountId)throw new BadRequestException("Choose a messaging account");
    const result=await this.execute(()=>this.operations.metaStatementRead({tenantId:input(()=>metaCostUuid(tenantId)),accountId:window.accountId,
      id:null,from:window.from,to:window.to,operator:request.platformOperator,requestId:String(request.id)}));
    if(!Array.isArray(result.statements)||result.statements.length>1000)throw new ConflictException("Choose a shorter statement period");
    return result;
  }

  @Get("tenants/:tenantId/statements/:statementId")
  statement(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Param("statementId") statementId:string){
    const scope=input(()=>({tenantId:metaCostUuid(tenantId),id:metaCostUuid(statementId)}));
    return this.execute(()=>this.operations.metaStatementRead({...scope,accountId:null,from:null,to:null,operator:request.platformOperator,requestId:String(request.id)}));
  }

  @Post("tenants/:tenantId/statements/:statementId/source-access")
  async sourceAccess(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Param("statementId") statementId:string,@Body() body:unknown){
    const operation=input(()=>{const value=object(body,["operation"]);if(value.operation!=="READ"&&value.operation!=="UPLOAD")throw new Error("Invalid source operation");return value.operation;});
    const scope=input(()=>({tenantId:metaCostUuid(tenantId),id:metaCostUuid(statementId)}));
    const source=await this.statement(request,scope.tenantId,scope.id);
    if(typeof source.originalSha256!=="string"||typeof source.originalByteSize!=="number"||typeof source.originalMime!=="string"
      ||source.sourceFenced===true||source.state==="REJECTED"||source.state==="EXPIRED"||!['READY','RESERVED'].includes(String(source.sourceState))
      ||(source.state!=="PUBLISHED"&&(typeof source.expiresAt!=="string"||Date.parse(source.expiresAt)<=Date.now()))
      ||(operation==="READ"&&source.sourceState!=="READY")
      ||(source.sourceState==="READY"&&(typeof source.sourceDeleteAfter!=="string"||Date.parse(source.sourceDeleteAfter)<=Date.now())))
      throw new ConflictException("The original source is unavailable or requires review");
    return{...scope,token:await this.drain.issueMetaCostSourceToken(scope.tenantId,scope.id,operation),sha256:source.originalSha256,byteSize:source.originalByteSize,mimeType:source.originalMime};
  }

  @Post("tenants/:tenantId/statements/:statementId/:operation")
  transitionStatement(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Param("statementId") statementId:string,
    @Param("operation") operation:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    const actions:Record<string,string>={review:"META_STATEMENT_REVIEW",preview:"META_STATEMENT_PREVIEW",publish:"META_STATEMENT_PUBLISH",
      "reconcile-source":"META_SOURCE_RECONCILE","privacy-review":"META_SOURCE_PRIVACY_REVIEW"};
    const action=actions[operation];if(!action)throw new NotFoundException("Statement operation was not found");
    const parsed=input(()=>{
      if(!body||typeof body!=="object"||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body),"utf8")>524_288)throw new Error("Invalid statement transition");
      const value=body as Record<string,unknown>;
      if(!Number.isSafeInteger(value.expectedVersion)||Number(value.expectedVersion)<1)throw new Error("Invalid statement version");
      // Domain SQL validates every finite action field and nested review item;
      // no client mode, amount or current-policy attribution is accepted here.
      return value;
    });
    return this.statementAction(request,action,tenantId,input(()=>metaCostUuid(statementId)),parsed,key);
  }

  private statementAction(request:PlatformOperatorRequest,action:string,tenantId:string,objectId:string|null,body:unknown,key:string|undefined){
    const scope=input(()=>{if(!key||key.length>255||key.trim()!==key||/[\p{Cc}\p{Cf}]/u.test(key))throw new Error("Invalid request key");return{tenantId:metaCostUuid(tenantId),idempotencyKey:key};});
    return this.execute(()=>this.operations.metaStatementAction({...scope,action,objectId,body,operator:request.platformOperator,requestId:String(request.id)}));
  }
}

export function parseCostWindow(account?: string, from?: string, to?: string) {
  return input(() => {
    const now = new Date(), fromValue = metaCostTimestamp(from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());
    const toValue = metaCostTimestamp(to ?? now.toISOString());
    if (fromValue >= toValue || Date.parse(toValue) - Date.parse(fromValue) > 366 * 86400000) throw new Error("Invalid cost period");
    return { accountId: account === undefined || account === "unattributed" ? null : metaCostUuid(account), from: fromValue, to: toValue };
  });
}

export function metaCostCsv(snapshot: MetaCostUsageSnapshot) {
  if (!snapshot.complete || snapshot.rows.length > 10000) throw new ConflictException("Choose a shorter period to export complete usage");
  const rows = [["assessment", "delivery", "account", "purpose", "evidence_mode", "state", "reason", "delivered_at", "time_basis", "reported_free", "payment_mode", "payer_state", "tariff_version", "currency", "rounding", "unrounded_amount", "amount", "assessment_digest", "receipt_set_digest", "admission_digest", "admission_digest_format", "evidence_redacted", "selection_count", "selection_digest"],
    ...snapshot.rows.map(row => [row.id, row.deliveryId, row.accountId, row.purpose, row.evidenceMode, row.state, row.reason, row.deliveredAt,
      row.timeBasis, row.reportedFree, row.paymentMode, row.payerState, row.tariffVersionId, row.currency, row.rounding, row.unroundedAmount, row.amount,
      row.inputSha256, row.receiptSetSha256, row.admissionSha256, row.admissionDigestFormat, row.evidenceRedacted, snapshot.selectedCount, snapshot.selectedSha256])];
  const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  if (Buffer.byteLength(csv, "utf8") > 10 * 1024 * 1024) throw new ConflictException("Choose a shorter period to export complete usage");
  return csv;
}
function input<T>(parse: () => T): T {
  try { return parse(); } catch { throw new BadRequestException("The cost request is invalid"); }
}
function object(value: unknown, expected: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== expected.sort().join(",")) throw new Error("Invalid cost fields");
  return value as Record<string, unknown>;
}
