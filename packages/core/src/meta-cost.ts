export const META_COST_PURPOSES = ["UPSTREAM_REFERENCE", "CUSTOMER_TARIFF"] as const;
export const META_COST_MODES = ["LIVE", "SIMULATED"] as const;
export type MetaCostPurpose = typeof META_COST_PURPOSES[number];
export type MetaCostMode = typeof META_COST_MODES[number];
export type MetaCostUsageSnapshot = {
  complete: boolean; selectedCount: number; selectedSha256: string; from: string; to: string; accountId: string | null;
  rows: Array<{
    id: string | null; deliveryId: string; accountId: string | null; purpose: MetaCostPurpose; evidenceMode: MetaCostMode | "UNKNOWN";
    state: "UNATTRIBUTED" | "UNPRICED" | "ESTIMATED" | "CONFLICTED"; reason: string; delivered: boolean; reportedFree: boolean;
    deliveredAt: string | null; observedAt: string; tariffVersionId: string | null; currency: string | null; minorUnits: number | null;
    rounding: "LINE" | "PERIOD" | null; unroundedAmount: string | null; amount: string | null; evidenceRedacted: boolean;
    inputSha256: string | null; receiptSetSha256: string | null; admissionSha256: string | null;
    admissionDigestFormat: "pg-jsonb-text-v1" | null; paymentMode: "CUSTOMER" | "MANAGED" | "UNKNOWN";
    payerState: "UNVERIFIED" | "APPROVED_SOLUTION_PARTNER" | "UNKNOWN"; timeBasis: "PROVIDER_DELIVERED_TIMESTAMP" | "UNKNOWN";
  }>;
  totals: Array<{
    purpose: MetaCostPurpose; evidenceMode: MetaCostMode; currency: string; minorUnits: number; rounding: "LINE" | "PERIOD";
    tariffVersionId: string; periodFrom: string; periodTo: string; quantity: number; unroundedAmount: string; amount: string | null; partialPeriod: boolean;
  }>;
  coverage: Array<{ purpose: MetaCostPurpose; evidence_mode: MetaCostMode | "UNKNOWN"; effects: number; delivered: number; reported_free: number; estimated: number; unresolved: number }>;
};
export type MetaCostCategory = "marketing" | "utility" | "authentication" | "service";
export type MetaCostRate = {
  category: MetaCostCategory;
  pricingType: "regular" | "free_customer_service" | "free_entry_point";
  billable: boolean;
  schedule: "ORDINARY" | "AUTHENTICATION_INTERNATIONAL";
  market: string;
  tier: string;
  unitPrice: string;
};
export type MetaCostTariffInput = {
  tenantId: string;
  accountId: string;
  purpose: MetaCostPurpose;
  evidenceMode: MetaCostMode;
  sourceSha256: string;
  currency: string;
  minorUnits: number;
  timezone: string;
  effectiveFrom: string;
  effectiveTo: string;
  rounding: "LINE" | "PERIOD";
  product: "CLOUD_API";
  unit: "DELIVERED_MESSAGE";
  pricingModel: "PMP";
  policyFamily: "ORDINARY_BUSINESS_MESSAGING";
  commercialTermsVersionId: string | null;
  rates: MetaCostRate[];
};

/** Validation only: PostgreSQL NUMERIC owns all monetary calculations. */
export function metaCostDecimal(value: unknown, wholeDigits = 24, signed = false): string {
  if (typeof value !== "string" || value.length > wholeDigits + 14
    || !(signed ? /^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u : /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u).test(value)
    || value.replace(/^-/, "").split(".")[0]!.length > wholeDigits) {
    throw new Error("Invalid exact cost decimal");
  }
  const normalized = value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;
  return normalized === "-0" ? "0" : normalized;
}

export function parseMetaCostTariff(value: unknown): MetaCostTariffInput {
  const input = record(value);
  keys(input, ["tenantId", "accountId", "purpose", "evidenceMode", "sourceSha256", "currency", "minorUnits", "timezone", "effectiveFrom", "effectiveTo", "rounding", "product", "unit", "pricingModel", "policyFamily", "commercialTermsVersionId", "rates"]);
  const purpose = oneOf(input.purpose, META_COST_PURPOSES);
  const evidenceMode = oneOf(input.evidenceMode, META_COST_MODES);
  const effectiveFrom = metaCostTimestamp(input.effectiveFrom), effectiveTo = metaCostTimestamp(input.effectiveTo);
  if (effectiveFrom >= effectiveTo) throw new Error("Tariff interval must be ordered");
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/u.test(input.currency)) throw new Error("Invalid tariff currency");
  if (!Number.isInteger(input.minorUnits) || Number(input.minorUnits) < 0 || Number(input.minorUnits) > 3) throw new Error("Unsupported currency precision");
  if (typeof input.timezone !== "string" || input.timezone.length > 64) throw new Error("Invalid tariff timezone");
  // An explicit approved timezone is required; neither host timezone nor tenant locale is a pricing source.
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(0); } catch { throw new Error("Invalid tariff timezone"); }
  if (!Array.isArray(input.rates) || input.rates.length < 1 || input.rates.length > 128) throw new Error("Tariff requires 1 to 128 rates");
  const rates = input.rates.map(raw => {
    const rate = record(raw); keys(rate, ["category", "pricingType", "billable", "schedule", "market", "tier", "unitPrice"]);
    const category = oneOf(rate.category, ["marketing", "utility", "authentication", "service"] as const);
    const schedule = oneOf(rate.schedule, ["ORDINARY", "AUTHENTICATION_INTERNATIONAL"] as const);
    if (category !== "authentication" && schedule !== "ORDINARY") throw new Error("International schedule requires authentication");
    const pricingType = oneOf(rate.pricingType, ["regular", "free_customer_service", "free_entry_point"] as const);
    if (typeof rate.billable !== "boolean" || (pricingType === "regular") !== rate.billable
      || (pricingType === "free_customer_service" && category !== "utility" && category !== "service")) throw new Error("Unsupported tariff economic class");
    return { category, pricingType, billable: rate.billable, schedule, market: selector(rate.market), tier: selector(rate.tier), unitPrice: metaCostDecimal(rate.unitPrice, 12) };
  });
  const rateKey = (rate: MetaCostRate) => [rate.category, rate.pricingType, rate.billable, rate.schedule, rate.market, rate.tier].join(":");
  if (new Set(rates.map(rateKey)).size !== rates.length) throw new Error("Duplicate tariff selector");
  rates.sort((left, right) => rateKey(left).localeCompare(rateKey(right), "en"));
  const terms = input.commercialTermsVersionId === null ? null : metaCostUuid(input.commercialTermsVersionId);
  if ((purpose === "CUSTOMER_TARIFF") !== (terms !== null)) throw new Error("Customer tariff requires exact commercial terms");
  return {
    tenantId: metaCostUuid(input.tenantId), accountId: metaCostUuid(input.accountId), purpose, evidenceMode,
    sourceSha256: metaCostSha256(input.sourceSha256), currency: input.currency, minorUnits: input.minorUnits as number,
    timezone: input.timezone, effectiveFrom, effectiveTo, rounding: oneOf(input.rounding, ["LINE", "PERIOD"] as const),
    product: oneOf(input.product, ["CLOUD_API"] as const), unit: oneOf(input.unit, ["DELIVERED_MESSAGE"] as const),
    pricingModel: oneOf(input.pricingModel, ["PMP"] as const),
    policyFamily: oneOf(input.policyFamily, ["ORDINARY_BUSINESS_MESSAGING"] as const), commercialTermsVersionId: terms, rates,
  };
}

/** Explicit operator-approved selector evidence for the exact bounded effect set.
 * This is stored in the assessment history, never inferred from a recipient ID.
 */
export type MetaCostSelectorEvidence = {
  sourceSha256: string;
  evidenceMode: MetaCostMode;
  product: "CLOUD_API";
  unit: "DELIVERED_MESSAGE";
  policyFamily: "ORDINARY_BUSINESS_MESSAGING";
  market: string;
  marketBasis: "AUTHORITATIVE_EFFECT_MARKET" | "APPROVED_MARKET_INDEPENDENT_RATE";
  schedule: "ORDINARY" | "AUTHENTICATION_INTERNATIONAL";
  applicabilityFrom: string;
  applicabilityTo: string;
  tier: string;
  tierBasis: "AUTHORITATIVE_PORTFOLIO_TIER" | "APPROVED_PROVISIONAL_REFERENCE";
  timeBasis: "PROVIDER_DELIVERED_TIMESTAMP";
};

export function parseMetaCostSelectorEvidence(value: unknown): MetaCostSelectorEvidence {
  const input = record(value);
  keys(input, ["sourceSha256", "evidenceMode", "product", "unit", "policyFamily", "market", "marketBasis", "schedule", "applicabilityFrom", "applicabilityTo", "tier", "tierBasis", "timeBasis"]);
  const applicabilityFrom = metaCostTimestamp(input.applicabilityFrom), applicabilityTo = metaCostTimestamp(input.applicabilityTo);
  if (applicabilityFrom >= applicabilityTo) throw new Error("Selector applicability must be ordered");
  return {
    sourceSha256: metaCostSha256(input.sourceSha256), evidenceMode: oneOf(input.evidenceMode, META_COST_MODES),
    product: oneOf(input.product, ["CLOUD_API"] as const), unit: oneOf(input.unit, ["DELIVERED_MESSAGE"] as const),
    policyFamily: oneOf(input.policyFamily, ["ORDINARY_BUSINESS_MESSAGING"] as const),
    market: selector(input.market), marketBasis: oneOf(input.marketBasis, ["AUTHORITATIVE_EFFECT_MARKET", "APPROVED_MARKET_INDEPENDENT_RATE"] as const),
    schedule: oneOf(input.schedule, ["ORDINARY", "AUTHENTICATION_INTERNATIONAL"] as const), applicabilityFrom, applicabilityTo,
    tier: selector(input.tier), tierBasis: oneOf(input.tierBasis, ["AUTHORITATIVE_PORTFOLIO_TIER", "APPROVED_PROVISIONAL_REFERENCE"] as const),
    timeBasis: oneOf(input.timeBasis, ["PROVIDER_DELIVERED_TIMESTAMP"] as const),
  };
}

export function metaCostUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new Error("Invalid cost identifier");
  return value.toLowerCase();
}
export function metaCostSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error("Invalid cost evidence digest");
  return value;
}
export function metaCostTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid cost timestamp");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cost input");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join(",") !== expected.sort().join(",")) throw new Error("Unsupported cost fields");
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error("Unsupported cost value");
  return value as T;
}
function selector(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9_.-]{0,63}$/u.test(value)) throw new Error("Invalid cost selector");
  return value;
}

export const META_COST_SOURCE_MAX_BYTES = 10_485_760;
export type MetaCostStatementSummary={
  id:string;purpose:"UPSTREAM_CHARGE"|"CUSTOMER_CHARGE";basisKind:"UPSTREAM_SOURCE"|"CUSTOMER_TARIFF_DERIVATION";
  evidenceMode:"LIVE"|"SIMULATED"|"UNKNOWN";currency:string;periodFrom:string;periodTo:string;amount:string;
  coverage:string;quantity:number|null;publishedAt:string;predecessorId:string|null;publicationSha256:string;superseded:boolean;
  sourceAvailability:"REFERENCED_UPSTREAM"|"RETAINED_RESTRICTED"|"PURGED"|"UNAVAILABLE";
};
export const META_COST_STATEMENT_MAX_JSON_BYTES = 524_288;
export const META_COST_SOURCE_MIMES = ["application/pdf", "text/csv", "application/json"] as const;
export type MetaCostSourceMime = typeof META_COST_SOURCE_MIMES[number];
export type MetaCostStatementScope = {
  accountId: string; policyVersionId: string; commercialTermsVersionId: string;
  periodFrom: string; periodTo: string; timezone: string; currency: string; minorUnits: number;
};
export type MetaCostSourceLine = {
  sourceLineId: string; sourceLocator: string; kind: "CHARGE" | "CREDIT" | "DEBIT";
  amount: string; providerMessageId: string | null; quantity: string | null;
  priorSourceLineId: string | null;
};
export type MetaCostOriginalInput = MetaCostStatementScope & {
  schemaVersion: 1; basisKind: "UPSTREAM_SOURCE";
  source: {
    issuerKind: "META" | "APPROVED_PARTNER"; issuerAuthorityVersionId: string | null;
    documentId: string; documentRevision: string; sourceScopeLocator: string;
    originalSha256: string; originalByteSize: number; originalMime: MetaCostSourceMime;
    sourceIssuedAt: string; sourceKind: "FULL_REPLACEMENT" | "CREDIT_DEBIT_ADJUSTMENT";
    priorStatementVersionId: string | null; sourceAccountIdentifierKind: "MESSAGING_ACCOUNT_ID";
    sourceAccountIdentifier: string; coverage: "ACCOUNT_PERIOD" | "MESSAGE_EFFECTS";
    sourceTotal: string; sourceQuantity: string | null;
    grossOriginalTotal: string | null; excludedOriginalAmount: string | null; supportedSubtotalLocator: string | null;
  };
  lines: MetaCostSourceLine[];
};
export type MetaCostDerivedInput = MetaCostStatementScope & {
  schemaVersion: 1; basisKind: "CUSTOMER_TARIFF_DERIVATION"; tariffVersionId: string;
  upstreamStatementVersionIds: string[];
};
export type MetaCostStatementInput = MetaCostOriginalInput | MetaCostDerivedInput;

/** Provider IDs are transient match inputs. The SQL reserve function removes
 * them from stored normalized JSON after exact historical effect resolution. */
export function parseMetaCostStatement(value: unknown): MetaCostStatementInput {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > META_COST_STATEMENT_MAX_JSON_BYTES) throw new Error("Statement description is too large");
  const input = record(value);
  const common = ["schemaVersion", "basisKind", "accountId", "policyVersionId", "commercialTermsVersionId", "periodFrom", "periodTo", "timezone", "currency", "minorUnits"];
  const basisKind = oneOf(input.basisKind, ["UPSTREAM_SOURCE", "CUSTOMER_TARIFF_DERIVATION"] as const);
  keys(input, [...common, ...(basisKind === "UPSTREAM_SOURCE" ? ["source", "lines"] : ["tariffVersionId", "upstreamStatementVersionIds"])]);
  if (input.schemaVersion !== 1) throw new Error("Unsupported statement schema");
  const periodFrom = metaCostTimestamp(input.periodFrom), periodTo = metaCostTimestamp(input.periodTo);
  if (periodFrom >= periodTo || Date.parse(periodTo) - Date.parse(periodFrom) > 366 * 86_400_000) throw new Error("Invalid statement period");
  const timezone = statementText(input.timezone, 64);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0); } catch { throw new Error("Invalid statement timezone"); }
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/u.test(input.currency)
    || !Number.isInteger(input.minorUnits) || Number(input.minorUnits) < 0 || Number(input.minorUnits) > 3) throw new Error("Invalid statement currency");
  const scope = { accountId: metaCostUuid(input.accountId), policyVersionId: metaCostUuid(input.policyVersionId),
    commercialTermsVersionId: metaCostUuid(input.commercialTermsVersionId), periodFrom, periodTo,
    timezone, currency: input.currency, minorUnits: input.minorUnits as number };
  if (basisKind === "CUSTOMER_TARIFF_DERIVATION") {
    if (!Array.isArray(input.upstreamStatementVersionIds) || input.upstreamStatementVersionIds.length < 1 || input.upstreamStatementVersionIds.length > 100) throw new Error("Invalid upstream statement selection");
    const upstreamStatementVersionIds = input.upstreamStatementVersionIds.map(metaCostUuid);
    if (new Set(upstreamStatementVersionIds).size !== upstreamStatementVersionIds.length) throw new Error("Duplicate upstream statement");
    return { ...scope, schemaVersion: 1, basisKind, tariffVersionId: metaCostUuid(input.tariffVersionId), upstreamStatementVersionIds: upstreamStatementVersionIds.sort() };
  }
  const source = record(input.source);
  keys(source, ["issuerKind", "issuerAuthorityVersionId", "documentId", "documentRevision", "sourceScopeLocator", "originalSha256", "originalByteSize", "originalMime", "sourceIssuedAt", "sourceKind", "priorStatementVersionId", "sourceAccountIdentifierKind", "sourceAccountIdentifier", "coverage", "sourceTotal", "sourceQuantity", "grossOriginalTotal", "excludedOriginalAmount", "supportedSubtotalLocator"]);
  const issuerKind = oneOf(source.issuerKind, ["META", "APPROVED_PARTNER"] as const);
  const issuerAuthorityVersionId = source.issuerAuthorityVersionId === null ? null : metaCostUuid(source.issuerAuthorityVersionId);
  if ((issuerKind === "APPROVED_PARTNER") !== (issuerAuthorityVersionId !== null)) throw new Error("Partner source requires exact issuer authority");
  if (!Number.isSafeInteger(source.originalByteSize) || Number(source.originalByteSize) < 1 || Number(source.originalByteSize) > META_COST_SOURCE_MAX_BYTES) throw new Error("Invalid original size");
  const sourceKind = oneOf(source.sourceKind, ["FULL_REPLACEMENT", "CREDIT_DEBIT_ADJUSTMENT"] as const);
  const priorStatementVersionId = source.priorStatementVersionId === null ? null : metaCostUuid(source.priorStatementVersionId);
  if (sourceKind === "CREDIT_DEBIT_ADJUSTMENT" && priorStatementVersionId === null) throw new Error("Adjustment requires a published source basis");
  const coverage = oneOf(source.coverage, ["ACCOUNT_PERIOD", "MESSAGE_EFFECTS"] as const);
  if (!Array.isArray(input.lines) || input.lines.length > 1000 || (coverage === "MESSAGE_EFFECTS" && input.lines.length === 0)) throw new Error("Invalid statement line count");
  const lines = input.lines.map(raw => {
    const line = record(raw); keys(line, ["sourceLineId", "sourceLocator", "kind", "amount", "providerMessageId", "quantity", "priorSourceLineId"]);
    const kind = oneOf(line.kind, ["CHARGE", "CREDIT", "DEBIT"] as const), amount = metaCostDecimal(line.amount, 24, true);
    if ((kind === "CREDIT" && !amount.startsWith("-")) || (kind !== "CREDIT" && amount.startsWith("-"))) throw new Error("Line sign does not match its kind");
    return { sourceLineId: statementText(line.sourceLineId, 128), sourceLocator: statementText(line.sourceLocator, 256), kind, amount,
      providerMessageId: line.providerMessageId === null ? null : statementText(line.providerMessageId, 512),
      quantity: statementQuantity(line.quantity), priorSourceLineId: line.priorSourceLineId === null ? null : statementText(line.priorSourceLineId, 128) };
  });
  if (new Set(lines.map(line => line.sourceLineId)).size !== lines.length) throw new Error("Duplicate source line");
  const sourceTotal = metaCostDecimal(source.sourceTotal, 24, true);
  if (sourceKind === "FULL_REPLACEMENT" && sourceTotal.startsWith("-")) throw new Error("Replacement base cannot be negative");
  const grossOriginalTotal = source.grossOriginalTotal === null ? null : metaCostDecimal(source.grossOriginalTotal, 24, true);
  const excludedOriginalAmount = source.excludedOriginalAmount === null ? null : metaCostDecimal(source.excludedOriginalAmount, 24, true);
  const supportedSubtotalLocator = source.supportedSubtotalLocator === null ? null : statementText(source.supportedSubtotalLocator, 256);
  if ([grossOriginalTotal, excludedOriginalAmount, supportedSubtotalLocator].some(item => item === null)
    && [grossOriginalTotal, excludedOriginalAmount, supportedSubtotalLocator].some(item => item !== null)) throw new Error("Excluded original amounts require the complete subtotal evidence");
  const accountIdentifier = statementText(source.sourceAccountIdentifier, 32);
  if (!/^\d{5,32}$/u.test(accountIdentifier)) throw new Error("Invalid source account identifier");
  return { ...scope, schemaVersion: 1, basisKind, lines, source: { issuerKind, issuerAuthorityVersionId,
    documentId: statementText(source.documentId, 128), documentRevision: statementText(source.documentRevision, 128),
    sourceScopeLocator: statementText(source.sourceScopeLocator, 256), originalSha256: metaCostSha256(source.originalSha256),
    originalByteSize: source.originalByteSize as number, originalMime: oneOf(source.originalMime, META_COST_SOURCE_MIMES),
    sourceIssuedAt: metaCostTimestamp(source.sourceIssuedAt), sourceKind, priorStatementVersionId,
    sourceAccountIdentifierKind: oneOf(source.sourceAccountIdentifierKind, ["MESSAGING_ACCOUNT_ID"] as const),
    sourceAccountIdentifier: accountIdentifier, coverage, sourceTotal, sourceQuantity: statementQuantity(source.sourceQuantity),
    grossOriginalTotal, excludedOriginalAmount, supportedSubtotalLocator } };
}

export function parseMetaCostFinanceRetention(value: unknown) {
  const input = record(value); keys(input, ["expectedVersion", "sourceDays", "recordDays", "basisSha256", "policyVersionId", "commercialTermsVersionId"]);
  for (const field of ["expectedVersion", "sourceDays", "recordDays"] as const) if (!Number.isSafeInteger(input[field]) || Number(input[field]) < 1) throw new Error("Invalid retention version or days");
  if (Number(input.sourceDays) > Number(input.recordDays) || Number(input.recordDays) > 3650) throw new Error("Invalid finance retention interval");
  return { expectedVersion: input.expectedVersion as number, sourceDays: input.sourceDays as number, recordDays: input.recordDays as number,
    basisSha256: metaCostSha256(input.basisSha256), policyVersionId: metaCostUuid(input.policyVersionId), commercialTermsVersionId: metaCostUuid(input.commercialTermsVersionId) };
}

export function metaCostSourceKey(tenantId: string, versionId: string, sha256: string) {
  return `tenants/${metaCostUuid(tenantId)}/meta-cost-sources/${metaCostUuid(versionId)}/${metaCostSha256(sha256)}.bin`;
}
function statementText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Invalid statement text");
  return value;
}
function statementQuantity(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,11})$/u.test(value)) throw new Error("Invalid evidenced message quantity");
  return value;
}
