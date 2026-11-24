import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildMetaCostReferenceTariff } from "../scripts/meta-cost-reference-tariff.mjs";
import { metaPricingObservation } from "../packages/core/src/meta-pricing-observation.ts";
import {
  metaCostDecimal, parseMetaCostSelectorEvidence, parseMetaCostTariff,
} from "../packages/core/src/meta-cost.ts";

const tariff = () => ({
  tenantId: "31000000-0000-4000-8000-000000000001", accountId: "31000000-0000-4000-8000-000000000002",
  purpose: "UPSTREAM_REFERENCE", evidenceMode: "SIMULATED", sourceSha256: "a".repeat(64), currency: "USD", minorUnits: 2,
  timezone: "UTC", effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveTo: "2026-11-01T00:00:00.000Z",
  rounding: "PERIOD", product: "CLOUD_API", unit: "DELIVERED_MESSAGE", pricingModel: "PMP",
  policyFamily: "ORDINARY_BUSINESS_MESSAGING", commercialTermsVersionId: null,
  rates: [{ category: "utility", pricingType: "regular", billable: true, schedule: "ORDINARY", market: "SYNTHETIC", tier: "REFERENCE", unitPrice: "0.005" }],
});
const selector = () => ({
  sourceSha256: "b".repeat(64), evidenceMode: "SIMULATED", product: "CLOUD_API", unit: "DELIVERED_MESSAGE",
  policyFamily: "ORDINARY_BUSINESS_MESSAGING", market: "SYNTHETIC", marketBasis: "AUTHORITATIVE_EFFECT_MARKET",
  schedule: "ORDINARY", applicabilityFrom: "2026-10-01T00:00:00.000Z", applicabilityTo: "2026-11-01T00:00:00.000Z",
  tier: "REFERENCE", tierBasis: "APPROVED_PROVISIONAL_REFERENCE", timeBasis: "PROVIDER_DELIVERED_TIMESTAMP",
});

test("tariff preserves exact decimals and requires one complete supported selector per rate", () => {
  assert.equal(parseMetaCostTariff(tariff()).rates[0]!.unitPrice, "0.005");
  for (const change of [
    { rates: [...tariff().rates, ...tariff().rates] }, { rates: [{ ...tariff().rates[0], schedule: "AUTHENTICATION_INTERNATIONAL" }] },
    { rates: [{ ...tariff().rates[0], category: "general_purpose_ai" }] }, { rates: [{ ...tariff().rates[0], unitPrice: 0.005 }] },
    { product: "MARKETING_MESSAGES_API" }, { unit: "CONVERSATION" }, { pricingModel: "CBP" },
    { policyFamily: "AI_PROVIDER" }, { evidenceMode: "UNKNOWN" }, { timezone: "not/a-zone" },
    { effectiveTo: tariff().effectiveFrom }, { effectiveFrom: "2026-02-30T00:00:00.000Z" },
    { sourceSha256: "" }, { minorUnits: 4 }, { actualPayer: "VERIFIED" },
  ]) assert.throws(() => parseMetaCostTariff({ ...tariff(), ...change }));
  const accepted = parseMetaCostTariff({ ...tariff(), rates: [{ ...tariff().rates[0], category: "authentication", schedule: "AUTHENTICATION_INTERNATIONAL" }] });
  assert.equal(accepted.rates[0]!.schedule, "AUTHENTICATION_INTERNATIONAL");
});

test("customer tariff binds an exact commercial terms version; a digest does not replace it", () => {
  assert.throws(() => parseMetaCostTariff({ ...tariff(), purpose: "CUSTOMER_TARIFF" }));
  const terms = "31000000-0000-4000-8000-000000000003";
  assert.equal(parseMetaCostTariff({ ...tariff(), purpose: "CUSTOMER_TARIFF", commercialTermsVersionId: terms }).commercialTermsVersionId, terms);
  assert.throws(() => parseMetaCostTariff({ ...tariff(), commercialTermsVersionId: terms }));
});

test("decimal grammar never admits JS money, exponents, truncation or silent overflow", () => {
  assert.equal(metaCostDecimal("12345678901234567890.123456"), "12345678901234567890.123456");
  assert.equal(metaCostDecimal("-0.005", 24, true), "-0.005");
  assert.equal(metaCostDecimal("0.005000"), "0.005");
  assert.equal(metaCostDecimal("-0.000", 24, true), "0");
  for (const value of [0, 0.005, "1e-3", "+1", "01", " 1", "1.", ".1", "NaN", "Infinity", "0.1234567890123", "1234567890123456789012345"])
    assert.throws(() => metaCostDecimal(value));
  assert.throws(() => metaCostDecimal("1000000000000", 12));
  assert.throws(() => metaCostDecimal("-0.005"));
});

test("selector evidence is explicit, bounded in time and cannot derive market from recipient data", () => {
  assert.equal(parseMetaCostSelectorEvidence(selector()).market, "SYNTHETIC");
  for (const change of [{ marketBasis: "PHONE_PREFIX" }, { timeBasis: "RECEIVED_AT" }, { tierBasis: "LOCAL_SEND_COUNT" },
    { evidenceMode: "UNKNOWN" }, { applicabilityTo: selector().applicabilityFrom }, { phone: "12025550136" },
    { sourceSha256: null }, { market: "" }, { product: "MARKETING_MESSAGES_API" }]) {
    assert.throws(() => parseMetaCostSelectorEvidence({ ...selector(), ...change }));
  }
});

test("October Meta pricing receipts distinguish the free service tier from paid deliveries", () => {
  const regular = { billable: true, pricing_model: "PMP", category: "service", type: "regular" };
  const free = { ...regular, billable: false, type: "free_customer_service", subtype: "free_tier" };
  const observe = (pricing: object) => metaPricingObservation({ pricing });
  const freeObservation = observe(free);
  assert.equal(freeObservation.state, "VALID");
  assert.equal(freeObservation.type, "free_customer_service");
  assert.equal(freeObservation.billable, false);
  assert.equal(observe(regular).billable, true);
  assert.equal(observe({ ...regular, category: "utility" }).billable, true);

  for (const invalid of [
    { ...free, subtype: "unknown" },
    { ...free, category: "utility" },
    { ...free, pricing_model: "CBP" },
    { ...regular, subtype: "free_tier" },
    { ...free, other: "unexpected" },
  ]) assert.equal(observe(invalid).state, "UNAVAILABLE");
});

const referenceCatalog = () => JSON.parse(readFileSync(
  new URL("../packages/core/config/meta-cost-2026-10-01.json", import.meta.url), "utf8",
));
const referenceScope = {
  tenantId: tariff().tenantId, accountId: tariff().accountId, evidenceMode: "LIVE",
  currency: "SAR", minorUnits: 2, timezone: "Asia/Riyadh", rounding: "PERIOD",
  effectiveFrom: "2026-09-30T21:00:00.000Z", effectiveTo: "2026-10-31T21:00:00.000Z",
  markets: ["SAUDI_ARABIA"],
};

test("October Meta tariff uses the published service and utility rates by currency and tier", () => {
  const catalog = referenceCatalog();
  assert.equal(catalog.effectiveDate, "2026-10-01");
  assert.equal(catalog.monthlyFreeServiceMessagesPerNumber, 1_000);
  assert.equal(Object.keys(catalog.cards).length, 16);
  for (const card of Object.values(catalog.cards) as Array<{ markets: object }>) {
    assert.equal(Object.keys(card.markets).length, 47);
  }

  const sar = buildMetaCostReferenceTariff(catalog, referenceScope);
  const usd = buildMetaCostReferenceTariff(catalog, { ...referenceScope, currency: "USD" });
  const rate = (definition: ReturnType<typeof parseMetaCostTariff>, category: string, tier: string) =>
    definition.rates.find(row => row.category === category && row.tier === tier);
  assert.equal(rate(sar, "service", "LIST")?.unitPrice, "0.0401");
  assert.equal(rate(sar, "utility", "LIST")?.unitPrice, "0.0401");
  assert.equal(rate(sar, "utility", "TIER_1")?.unitPrice, "0.0381");
  assert.equal(rate(usd, "service", "LIST")?.unitPrice, "0.0107");
  assert.equal(rate(usd, "utility", "TIER_1")?.unitPrice, "0.0102");
  assert.ok(sar.rates.every((row: { pricingType: string }) => row.pricingType === "regular"));
  assert.deepEqual(parseMetaCostTariff(sar), sar);
  assert.match(sar.sourceSha256, /^[0-9a-f]{64}$/u);
});

test("reference tariff rejects missing rates and dates outside the account-local pricing period", () => {
  const catalog = referenceCatalog();
  assert.throws(() => buildMetaCostReferenceTariff(catalog, { ...referenceScope, currency: "JPY" }), /Unverified.*JPY/u);
  assert.throws(() => buildMetaCostReferenceTariff(catalog, { ...referenceScope, markets: ["UNKNOWN"] }), /Unverified.*SAR\/UNKNOWN/u);
  assert.throws(() => buildMetaCostReferenceTariff(catalog, {
    ...referenceScope, effectiveFrom: "2026-09-30T20:59:59.999Z",
  }), /outside the Meta pricing period/u);
  assert.throws(() => buildMetaCostReferenceTariff(catalog, {
    ...referenceScope, effectiveTo: "2026-12-31T21:00:00.001Z",
  }), /outside the Meta pricing period/u);

  catalog.cards.USD.markets.SAUDI_ARABIA.service = "0";
  assert.throws(() => buildMetaCostReferenceTariff(catalog, referenceScope), /Invalid Meta pricing row USD\/SAUDI_ARABIA/u);
});
