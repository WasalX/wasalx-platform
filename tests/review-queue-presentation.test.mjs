import assert from "node:assert/strict";
import test from "node:test";

import { arabicTenantMessages } from "../lib/i18n/messages/ar/tenant.ts";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";

const source = readTenantPortalSource();
const reasons = [
  "identifier_limit_exceeded",
  "media_malware_detected",
  "media_too_large",
  "media_type_unsafe",
  "media_download_rejected",
  "outbound_media_rejected",
  "provider_delivery_failed",
  "non_retryable_review",
  "group_action_outcome_unknown",
];

test("review queue presents only bounded localized reasons and summaries", () => {
  for (const reason of reasons) {
    assert.match(source, new RegExp(`"${reason}"`, "u"));
    assert.equal(typeof englishTenantMessages[`tenant.deliveries.review.reason.${reason}`], "string");
    assert.equal(typeof arabicTenantMessages[`tenant.deliveries.review.reason.${reason}`], "string");
    assert.equal(typeof englishTenantMessages[`tenant.deliveries.review.summary.${reason}`], "string");
    assert.equal(typeof arabicTenantMessages[`tenant.deliveries.review.summary.${reason}`], "string");
  }
  assert.match(source, /reviewReason\(item,t\)[\s\S]*reviewSummary\(item,t\)/u);
  assert.match(source, /reviewSummary\(detail,t\)/u);
  assert.doesNotMatch(source, /safe_summary/u);
});

test("unknown review codes and sources fail to generic safe copy", () => {
  const en = createTranslator(englishTenantMessages);
  const ar = createTranslator(arabicTenantMessages);
  assert.equal(en("tenant.deliveries.review.reason.unknown"), "Needs operator review");
  assert.equal(ar("tenant.deliveries.review.reason.unknown"), "يحتاج إلى مراجعة المشغل");
  assert.match(en("tenant.deliveries.review.summary.unknown"), /Technical details are hidden/u);
  assert.match(ar("tenant.deliveries.review.summary.unknown"), /التفاصيل التقنية مخفية/u);
  assert.match(source, /REVIEW_REASON_KEYS\.has\(reason\)[\s\S]*tenant\.deliveries\.review\.reason\.unknown/u);
  assert.match(source, /REVIEW_SOURCE_KEYS\.has\(source\)[\s\S]*tenant\.deliveries\.review\.source\.unknown/u);
});

test("review lifecycle states have exact English and Arabic presentation", () => {
  const en = createTranslator(englishTenantMessages);
  const ar = createTranslator(arabicTenantMessages);
  assert.deepEqual(
    [en("tenant.status.open"), en("tenant.status.resolved"), en("tenant.status.discarded")],
    ["Open", "Resolved", "Discarded"],
  );
  assert.deepEqual(
    [ar("tenant.status.open"), ar("tenant.status.resolved"), ar("tenant.status.discarded")],
    ["مفتوح", "تم الحل", "تم التجاهل"],
  );
  assert.match(source, /REVIEW_STATE_KEYS = new Set\(\["open", "resolved", "discarded", "reprocess_queued"\]\)/u);
  assert.match(source, /<Status value=\{reviewState\(item\.state\)\}/u);
  assert.match(source, /<Status value=\{reviewState\(detail\.state\)\}/u);
});
