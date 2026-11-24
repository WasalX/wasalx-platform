# Meta upstream message cost estimates

The [October 2026 pricing catalog](../../packages/core/config/meta-cost-2026-10-01.json) records Meta's effective date, monthly service allowance, and the SHA-256 of each underlying list-rate and tier workbook. It covers ordinary Cloud API messaging across the markets and currencies in [Meta's October 1, 2026 rate cards](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#rate-cards-and-volume-tiers). The catalog ends at the next possible price change in [Meta's pricing calendar](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#pricing-calendar).

Meta reports which delivered service messages qualify for its [monthly per-number free tier](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing#free-tier-of-monthly-service-messages). WasalX uses those receipts so service messages sent through other integrations on the same number are accounted for by Meta. A regular delivered service message uses the list rate. Regular utility replies use the applicable utility rate, including inside the customer service window. Free-entry-point receipts still report zero upstream cost. The `CUSTOMER_TARIFF` follows the account's separately accepted commercial terms.

## Prepare an upstream reference tariff

Use the Messaging account's verified currency and timezone, account and tenant IDs and evidence mode. Supply UTC instants that delimit one full account calendar month when using period rounding. For example, the following scope covers October in a UTC+3 account and selects the Saudi Arabia market. The identifiers are synthetic.

```json
{
  "tenantId": "31000000-0000-4000-8000-000000000001",
  "accountId": "31000000-0000-4000-8000-000000000002",
  "evidenceMode": "LIVE",
  "currency": "SAR",
  "minorUnits": 2,
  "timezone": "Asia/Riyadh",
  "effectiveFrom": "2026-09-30T21:00:00.000Z",
  "effectiveTo": "2026-10-31T21:00:00.000Z",
  "rounding": "PERIOD",
  "markets": ["SAUDI_ARABIA"]
}
```

Run from the repository root with the supported Node.js version. Save the output as UTF-8 JSON.

```sh
node scripts/meta-cost-reference-tariff.mjs packages/core/config/meta-cost-2026-10-01.json scope.json > tariff.json
```

Choose the markets the account needs. The existing tariff schema admits up to 128 rate rows per version. Market keys are the catalog's upper-case keys. The selector tier is `LIST` for the list rate and `TIER_1`, `TIER_2`, and so on for the subsequent published tiers. The tier arrays give the inclusive volume range and the exact price. A null upper bound means the final tier has no upper limit.

Upload the generated file in Meta Costs, review the draft, then activate it using the existing platform operator workflow. The tariff's source digest binds the complete catalog. Reassess paid deliveries with approved market and tier selector evidence. The provider decides the utility tier across the messaging portfolio. WasalX leaves estimates unpriced when the required evidence or an applicable tariff row is absent.
