import assert from "node:assert/strict";
import test from "node:test";
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
