import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  metaCostDecimal, metaCostSha256, metaCostTimestamp, parseMetaCostTariff,
} from "../packages/core/src/meta-cost.ts";

const tieredCategories = [
  { key: "utility", category: "utility", schedule: "ORDINARY" },
  { key: "authentication", category: "authentication", schedule: "ORDINARY" },
  { key: "authenticationInternational", category: "authentication", schedule: "AUTHENTICATION_INTERNATIONAL" },
];

function configDate(value) {
  if (typeof value !== "string") throw new Error("Invalid Meta pricing date");
  metaCostTimestamp(value + "T00:00:00.000Z");
  return value;
}

function paidRate(category, market, tier, unitPrice, schedule = "ORDINARY") {
  const price = metaCostDecimal(unitPrice, 12);
  if (price === "0") throw new Error("Expected a positive list or tier rate");
  return { category, market, tier, unitPrice: price, schedule, pricingType: "regular", billable: true };
}

function parseCatalog(source) {
  if (source?.schemaVersion !== 1 || new URL(source.sourceUrl).protocol !== "https:"
    || !Number.isSafeInteger(source.monthlyFreeServiceMessagesPerNumber)
    || source.monthlyFreeServiceMessagesPerNumber < 1
    || configDate(source.effectiveDate) >= configDate(source.effectiveBefore)) {
    throw new Error("Invalid Meta pricing catalog");
  }
  const cards = new Map();
  for (const [currency, card] of Object.entries(source.cards)) {
    if (!/^[A-Z]{3}$/u.test(currency)) throw new Error("Invalid Meta pricing currency " + currency);
    metaCostSha256(card.listSha256);
    metaCostSha256(card.tiersSha256);
    const markets = new Map();
    for (const [market, row] of Object.entries(card.markets)) {
      try {
        if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/u.test(market)) throw new Error("Invalid market key");
        const rates = [paidRate("service", market, "LIST", row.service), paidRate("marketing", market, "LIST", row.marketing)];
        for (const { key, category, schedule } of tieredCategories) {
          const tiers = row[key];
          if (!Array.isArray(tiers) || (tiers.length === 0 && key !== "authenticationInternational")) {
            throw new Error("Missing " + key + " tiers");
          }
          let expectedStart = 0;
          for (const [index, tier] of tiers.entries()) {
            if (!Array.isArray(tier) || tier.length !== 3) throw new Error("Invalid " + key + " tier row");
            const [start, end, price] = tier;
            if (start !== expectedStart || (index === tiers.length - 1 ? end !== null : !Number.isSafeInteger(end) || end < start)) {
              throw new Error("Invalid " + key + " tier bounds");
            }
            rates.push(paidRate(category, market, index === 0 ? "LIST" : "TIER_" + index, price, schedule));
            expectedStart = end + 1;
          }
        }
        markets.set(market, rates);
      } catch (error) {
        throw new Error("Invalid Meta pricing row " + currency + "/" + market + ": " + error.message, { cause: error });
      }
    }
    cards.set(currency, markets);
  }
  return cards;
}

export function buildMetaCostReferenceTariff(source, scope) {
  const { markets, ...definition } = scope;
  const card = parseCatalog(source).get(definition.currency);
  if (!card) throw new Error("Unverified Meta pricing currency " + definition.currency);
  if (!Array.isArray(markets) || markets.length === 0 || new Set(markets).size !== markets.length) {
    throw new Error("Select distinct Meta pricing markets");
  }
  const rates = markets.flatMap(market => {
    const rows = card.get(market);
    if (!rows) throw new Error("Unverified Meta pricing market " + definition.currency + "/" + market);
    return rows;
  });
  const tariff = parseMetaCostTariff({
    ...definition, purpose: "UPSTREAM_REFERENCE", commercialTermsVersionId: null,
    product: "CLOUD_API", pricingModel: "PMP", unit: "DELIVERED_MESSAGE", policyFamily: "ORDINARY_BUSINESS_MESSAGING",
    sourceSha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"), rates,
  });
  const localDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tariff.timezone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  if (localDate.format(Date.parse(tariff.effectiveFrom)) < source.effectiveDate
    || localDate.format(Date.parse(tariff.effectiveTo) - 1) >= source.effectiveBefore) {
    throw new Error("Tariff falls outside the Meta pricing period in the Messaging account timezone");
  }
  return tariff;
}

if (import.meta.main) {
  const [catalogPath, scopePath] = process.argv.slice(2);
  if (!catalogPath || !scopePath || process.argv.length !== 4) {
    throw new Error("Usage: node scripts/meta-cost-reference-tariff.mjs <catalog.json> <scope.json>");
  }
  const source = JSON.parse(readFileSync(catalogPath, "utf8"));
  const scope = JSON.parse(readFileSync(scopePath, "utf8"));
  process.stdout.write(JSON.stringify(buildMetaCostReferenceTariff(source, scope), null, 2) + "\n");
}
