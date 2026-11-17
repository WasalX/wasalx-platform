import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  Req,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import {parseMetaTransitionOperatorRequest,type MetaTransitionOperatorAction} from '@wasalx/core/meta-transition-operator-contract';
import {MetaManagedApprovalService} from "./meta-managed-approval.service.js";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { MeteringAuthService } from "./metering-auth.service.js";
import type { MeteringObservation } from "./metering.repository.js";
import { MeteringService } from "./metering.service.js";
import {
  PlatformOperatorGuard,
  PlatformOperatorOnly,
  SkipTenantAuthentication,
} from "./platform-operator-auth.js";
import { PlatformOperationsService } from "./platform-operations.service.js";
import type { PlatformOperatorRequest } from "./tenant-provisioning.types.js";

export const meterKeys = [
  "CONNECTED_NUMBER_HOURS",
  "ACTIVE_GROUP_HOURS",
  "INBOUND_MESSAGES",
  "OUTBOUND_MESSAGES",
  "MEDIA_BYTES",
  "ZAMMAD_CPU_CORE_HOURS",
  "ZAMMAD_MEMORY_GIB_HOURS",
  "ZAMMAD_STORAGE_GIB_HOURS",
  "WAHA_SESSION_HOURS",
  "WAHA_CAPACITY_UNIT_HOURS",
] as const;

const meterKeySet = new Set<string>(meterKeys);

@Controller("platform/v1/operations")
@SkipTenantAuthentication()
@PlatformOperatorOnly()
@UseGuards(PlatformOperatorGuard)
export class PlatformOperationsController {
  constructor(private readonly operations: PlatformOperationsService,private readonly managedApproval:MetaManagedApprovalService) {}

  @Get("tenants/:tenantId/meta/account-transitions")
  metaTransitionReviewList(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string){
    return this.operations.metaTransitionReviewList(requireUuid(tenantId,"Workspace"),request.platformOperator,String(request.id));
  }
  @Get("tenants/:tenantId/meta/account-transitions/:id/review")
  metaTransitionReview(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Param("id") id:string,@Query() query:Record<string,unknown>){
    if(Object.keys(query).some(key=>key!=="requestKey")||query.requestKey!==undefined&&typeof query.requestKey!=="string")throw new BadRequestException("Review query is invalid.");
    return this.operations.metaTransitionReview(requireUuid(tenantId,"Workspace"),requireUuid(id,"Transition"),
      query.requestKey===undefined?null:requireUuid(query.requestKey,"Request"),request.platformOperator,String(request.id));
  }
  @Post("tenants/:tenantId/meta/account-transitions/:id/review/:action")
  metaTransitionReviewCommand(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Param("id") id:string,
    @Param("action") action:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.metaTransitionReviewRequest(request,tenantId,id,action,key,body,false);
  }
  @Post("tenants/:tenantId/meta/account-transitions/:id/review/:action/resolve")
  metaTransitionReviewResolution(@Req() request:PlatformOperatorRequest,@Param("tenantId") tenantId:string,@Param("id") id:string,
    @Param("action") action:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.metaTransitionReviewRequest(request,tenantId,id,action,key,body,true);
  }
  private metaTransitionReviewRequest(request:PlatformOperatorRequest,tenantId:string,id:string,action:string,key:string|undefined,body:unknown,resolve:boolean){
    const actions:Record<string,MetaTransitionOperatorAction>={prerequisites:'PREREQUISITES',target:'TARGET',completion:'COMPLETION'};
    const selected=Object.hasOwn(actions,action)?actions[action]:undefined;
    const parsed=selected?parseMetaTransitionOperatorRequest(selected,body):null;
    if(!selected||!parsed||typeof key!=="string")throw new BadRequestException("Review command is invalid.");
    return this.operations.metaTransitionReviewCommand(requireUuid(tenantId,"Workspace"),requireUuid(id,"Transition"),selected,
      requireUuid(key,"Request"),parsed,resolve,request.platformOperator,String(request.id));
  }

  @Post("meta/account-transitions/:id/prerequisites/simulated")
  authorizeMetaTransition(@Req() request:PlatformOperatorRequest,@Param("id") id:string,@Body() body:unknown){
    const v=body as Record<string,unknown>;
    if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==2
      ||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<1
      ||!v.proof||typeof v.proof!=="object"||Array.isArray(v.proof))throw new BadRequestException("Transition review is invalid.");
    return this.operations.authorizeMetaTransition(requireUuid(id,"Transition"),Number(v.expectedRevision),v.proof,request.platformOperator,String(request.id));
  }
  @Post("meta/account-transitions/:id/target-review/simulated")
  reviewMetaTransitionTarget(@Req() request:PlatformOperatorRequest,@Param("id") id:string,@Body() body:unknown){
    const v=body as Record<string,unknown>;
    if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==2
      ||typeof v.observationOperationId!=="string"||!v.proof||typeof v.proof!=="object"||Array.isArray(v.proof))throw new BadRequestException("Target review is invalid.");
    return this.operations.reviewMetaTransitionTarget(requireUuid(id,"Transition"),requireUuid(v.observationOperationId,"Observation"),v.proof,request.platformOperator,String(request.id));
  }

  // This explicit review is separate from readback-only credential renewal.
  // The route is simulation-scoped until actual provider qualification exists.
  @Post("meta/account-transitions/:id/completion-authority/simulated")
  authorizeMetaTransitionCompletion(@Req() request:PlatformOperatorRequest,@Param("id") id:string,@Body() body:unknown){
    const v=body as Record<string,unknown>;
    if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(key=>!["expectedRevision","observerOperationId","proof"].includes(key))
      ||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<1||typeof v.observerOperationId!=="string"
      ||!v.proof||typeof v.proof!=="object"||Array.isArray(v.proof))throw new BadRequestException("Completion review is invalid.");
    return this.operations.authorizeMetaTransitionCompletion(requireUuid(id,"Transition"),Number(v.expectedRevision),requireUuid(v.observerOperationId,"Authorization"),v.proof,request.platformOperator,String(request.id));
  }

  @Post("meta/funding-arrangements/simulated")
  approveMetaArrangement(@Req() request:PlatformOperatorRequest,@Body() input:unknown){
    return this.managedApproval.approveSimulated(input,request.platformOperator,String(request.id));
  }
  @Post("meta/funding-arrangements/:id/revoke")
  revokeMetaArrangement(@Req() request:PlatformOperatorRequest,@Param("id") id:string){
    return this.operations.revokeMetaArrangement(requireUuid(id,"Arrangement"),request.platformOperator,String(request.id));
  }
  @Post("meta/funding-effects/:id/readback")
  queueMetaReadback(@Req() request:PlatformOperatorRequest,@Param("id") id:string,@Headers("idempotency-key") key:string|undefined,@Body() input:unknown){
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==1||!("expectedRevision" in input)
      ||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1)throw new BadRequestException("Funding admission is invalid.");
    return this.operations.queueMetaFundingReadback(requireUuid(id,"Financial effect"),Number(input.expectedRevision),requireIdempotencyKey(key),request.platformOperator,String(request.id));
  }
  @Post("meta/funding-arrangements/:id/attach")
  queueMetaAttachment(@Req() request:PlatformOperatorRequest,@Param("id") id:string,@Headers("idempotency-key") key:string|undefined,@Body() input:unknown){
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==1||!("expectedRevision" in input)
      ||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1)throw new BadRequestException("Funding admission is invalid.");
    return this.operations.queueMetaFundingAttachment(requireUuid(id,"Arrangement"),Number(input.expectedRevision),requireIdempotencyKey(key),request.platformOperator,String(request.id));
  }
  @Post("meta/commercial-terms/simulated")
  registerMetaTerms(@Req() request:PlatformOperatorRequest,@Body() input:unknown){
    return this.operations.registerMetaSimulatedTerms(input,request.platformOperator,String(request.id));
  }

  @Post("meta/runtime-evidence")
  registerMetaRuntime(@Req() request:PlatformOperatorRequest,@Body() input:unknown){
    return this.operations.registerMetaSimulatedRuntime(input,request.platformOperator,String(request.id));
  }
  @Post("meta/runtime-evidence/:receiptId/withdraw")
  withdrawMetaRuntime(@Req() request:PlatformOperatorRequest,@Param("receiptId") receiptId:string){
    return this.operations.withdrawMetaRuntime(requireUuid(receiptId,"Runtime receipt"),request.platformOperator,String(request.id));
  }

  @Get("overview")
  overview(@Req() request: PlatformOperatorRequest) {
    return this.operations.overview(
      request.platformOperator,
      String(request.id),
    );
  }

  @Get("tenants")
  tenants(
    @Req() request: PlatformOperatorRequest,
    @Query("state") rawState?: string,
    @Query("query") rawQuery?: string,
    @Query("limit") rawLimit?: string,
    @Query("cursor") rawCursor?: string,
  ) {
    return this.operations.tenants(
      parseTenantFilter(rawState, rawQuery, rawLimit, rawCursor),
      request.platformOperator,
      String(request.id),
    );
  }
}

@Controller("platform/v1/metering")
@SkipTenantAuthentication()
@PlatformOperatorOnly()
@UseGuards(PlatformOperatorGuard)
export class PlatformMeteringController {
  constructor(private readonly operations: PlatformOperationsService) {}

  @Get("tenants/:tenantId")
  usage(
    @Req() request: PlatformOperatorRequest,
    @Param("tenantId") rawTenantId: string,
    @Query("from") rawFrom?: string,
    @Query("to") rawTo?: string,
  ) {
    const window = parseUsageWindow(rawTenantId, rawFrom, rawTo);
    return this.operations.usage(
      window,
      request.platformOperator,
      String(request.id),
    );
  }

  @Get("rates")
  rates(@Req() request: PlatformOperatorRequest) {
    return this.operations.rates(
      request.platformOperator,
      String(request.id),
    );
  }

  @Put("tenants/:tenantId/quotas/:meter")
  setQuota(
    @Req() request: PlatformOperatorRequest,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
    @Param("tenantId") rawTenantId: string,
    @Param("meter") rawMeter: string,
    @Body() body: unknown,
  ) {
    return this.operations.setQuota({
      ...parseQuota(rawTenantId, rawMeter, body),
      idempotencyKey: requireIdempotencyKey(rawIdempotencyKey),
      operator: request.platformOperator,
      requestId: String(request.id),
    });
  }

  @Post("rates")
  setRate(
    @Req() request: PlatformOperatorRequest,
    @Headers("idempotency-key") rawIdempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.operations.setRate({
      ...parseRate(body),
      idempotencyKey: requireIdempotencyKey(rawIdempotencyKey),
      operator: request.platformOperator,
      requestId: String(request.id),
    });
  }
}

@Controller("internal/v1/metering")
@SetMetadata(PUBLIC_ROUTE, true)
export class MeteringIngestController {
  constructor(
    private readonly auth: MeteringAuthService,
    private readonly metering: MeteringService,
  ) {}

  @Post("events")
  async ingest(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const principal = await this.auth.authenticate(authorization);
    return this.metering.ingest(principal, parseMeteringBatch(body));
  }
}

export function parseTenantFilter(
  rawState?: string,
  rawQuery?: string,
  rawLimit?: string,
  rawCursor?: string,
) {
  const allowedStates = new Set([
    "PROVISIONING",
    "ACTIVE",
    "SUSPENDED",
    "DELETING",
    "PENDING",
    "RUNNING",
    "FAILED_RETRYABLE",
    "FAILED",
    "COMPLETE",
    "SUSPEND_PENDING",
    "SUSPENDING",
    "RESUME_PENDING",
    "RESUMING",
  ]);
  if (rawState !== undefined && !allowedStates.has(rawState)) {
    throw new BadRequestException("Tenant state filter is invalid");
  }
  const query = optionalText(rawQuery, "Tenant search", 160);
  const cursor = optionalText(rawCursor, "Tenant cursor", 64);
  if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cursor)) {
    throw new BadRequestException("Tenant cursor is invalid");
  }
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestException("Tenant result limit must be between 1 and 100");
  }
  return {
    state: rawState,
    query,
    limit,
    cursor,
  };
}

export function parseUsageWindow(
  rawTenantId: string,
  rawFrom?: string,
  rawTo?: string,
) {
  const tenantId = requireUuid(rawTenantId, "Tenant ID");
  const now = new Date();
  const defaultTo = now.toISOString();
  const defaultFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const from = isoTimestamp(rawFrom ?? defaultFrom, "Usage window start");
  const to = isoTimestamp(rawTo ?? defaultTo, "Usage window end");
  const fromTime = new Date(from).getTime();
  const toTime = new Date(to).getTime();
  if (
    fromTime >= toTime ||
    toTime - fromTime > 366 * 24 * 60 * 60 * 1_000 ||
    toTime > Date.now() + 5 * 60_000
  ) {
    throw new BadRequestException(
      "Usage window must be ordered, no longer than 366 days, and not in the future",
    );
  }
  return { tenantId, from, to };
}

export function parseMeteringBatch(body: unknown): MeteringObservation[] {
  if (!isRecord(body) || !Array.isArray(body.events)) {
    throw new BadRequestException("A metering events array is required");
  }
  if (body.events.length < 1 || body.events.length > 100) {
    throw new BadRequestException("A metering batch must contain 1 to 100 events");
  }
  const seen = new Set<string>();
  return body.events.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new BadRequestException(`Metering event ${index + 1} is invalid`);
    }
    const eventId = requiredToken(raw.eventId, "Metering event ID", 255);
    if (seen.has(eventId)) {
      throw new BadRequestException("Metering event IDs must be unique in a batch");
    }
    seen.add(eventId);
    const meter = requireMeter(raw.meter);
    const quantity = decimalQuantity(raw.quantity, "Metering quantity");
    const periodStart = isoTimestamp(raw.periodStart, "Metering period start");
    const periodEnd = isoTimestamp(raw.periodEnd, "Metering period end");
    const start = new Date(periodStart).getTime();
    const end = new Date(periodEnd).getTime();
    if (
      start >= end ||
      end - start > 24 * 60 * 60 * 1_000 ||
      end > Date.now() + 5 * 60_000 ||
      start < Date.now() - 366 * 24 * 60 * 60 * 1_000
    ) {
      throw new BadRequestException(
        "Metering periods must be ordered, at most 24 hours, and within the retention window",
      );
    }
    const resourceId = optionalText(raw.resourceId, "Metered resource ID", 255);
    return {
      eventId,
      meter,
      quantity,
      periodStart,
      periodEnd,
      resourceId,
    };
  });
}

export function parseQuota(
  rawTenantId: string,
  rawMeter: string,
  body: unknown,
) {
  if (!isRecord(body)) throw new BadRequestException("Quota configuration is required");
  const tenantId = requireUuid(rawTenantId, "Tenant ID");
  const meter = requireMeter(rawMeter);
  const period = body.period;
  if (period !== "DAY" && period !== "MONTH") {
    throw new BadRequestException("Quota period is invalid");
  }
  const softLimit = positiveDecimal(body.softLimit, "Quota soft limit");
  const hardLimit =
    body.hardLimit === undefined || body.hardLimit === null
      ? undefined
      : positiveDecimal(body.hardLimit, "Quota hard limit");
  if (hardLimit && compareDecimal(hardLimit, softLimit) < 0) {
    throw new BadRequestException("Quota hard limit cannot be below the soft limit");
  }
  const expectedVersion =
    body.expectedVersion === undefined ? undefined : Number(body.expectedVersion);
  if (
    expectedVersion !== undefined &&
    (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
  ) {
    throw new BadRequestException("Quota expectedVersion is invalid");
  }
  return { tenantId, meter, period, softLimit, hardLimit, expectedVersion };
}

export function parseRate(body: unknown) {
  if (!isRecord(body)) throw new BadRequestException("Meter rate is required");
  const meter = requireMeter(body.meter);
  const unitPriceMicros = Number(body.unitPriceMicros);
  if (
    !Number.isSafeInteger(unitPriceMicros) ||
    unitPriceMicros < 0 ||
    unitPriceMicros > 1_000_000_000_000
  ) {
    throw new BadRequestException("Meter unit price micros is invalid");
  }
  const currency = body.currency;
  if (currency !== "SAR" && currency !== "USD") {
    throw new BadRequestException("Meter currency must be SAR or USD");
  }
  const parsedEffectiveDate =
    typeof body.effectiveFrom === "string"
      ? new Date(`${body.effectiveFrom}T00:00:00.000Z`)
      : undefined;
  if (
    typeof body.effectiveFrom !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(body.effectiveFrom) ||
    !parsedEffectiveDate ||
    !Number.isFinite(parsedEffectiveDate.getTime()) ||
    parsedEffectiveDate.toISOString().slice(0, 10) !== body.effectiveFrom
  ) {
    throw new BadRequestException("Meter rate effective date is invalid");
  }
  const today = new Date().toISOString().slice(0, 10);
  const maximum = new Date(Date.now() + 366 * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  if (body.effectiveFrom < today || body.effectiveFrom > maximum) {
    throw new BadRequestException(
      "Meter rate effective date must be today or within the next 366 days",
    );
  }
  return { meter, unitPriceMicros, currency, effectiveFrom: body.effectiveFrom };
}

function requireMeter(value: unknown) {
  if (typeof value !== "string" || !meterKeySet.has(value)) {
    throw new BadRequestException("Meter key is invalid");
  }
  return value;
}

function decimalQuantity(value: unknown, label: string) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (
    typeof normalized !== "string" ||
    !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/u.test(normalized)
  ) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return normalized;
}

function positiveDecimal(value: unknown, label: string) {
  const result = decimalQuantity(value, label);
  if (compareDecimal(result, "0") <= 0) {
    throw new BadRequestException(`${label} must be positive`);
  }
  return result;
}

function compareDecimal(left: string, right: string) {
  const scaled = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(6, "0")}`);
  };
  const leftValue = scaled(left);
  const rightValue = scaled(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function isoTimestamp(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new BadRequestException(`${label} is required`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BadRequestException(`${label} must be an exact ISO timestamp`);
  }
  return value;
}

function requiredToken(value: unknown, label: string, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestException(`${label} is invalid`);
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return normalized;
}

function requireUuid(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new BadRequestException(`${label} must be a UUID`);
  }
  return value;
}

function requireIdempotencyKey(value: string | undefined) {
  if (
    !value ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new BadRequestException("A valid Idempotency-Key header is required");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
