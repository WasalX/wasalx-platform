import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmUnsavedNavigation,
  createLatestRequestFence,
  operatorResponseFailure,
  shouldPauseAutomaticRefresh,
  unmatchedReviewItems,
  visibleReviewMetadata,
} from "../lib/operator-ui.ts";

test("coded operator failures preserve localized structured reauthentication", async () => {
  const failure = await operatorResponseFailure(
    new Response(JSON.stringify({ code: "REAUTHENTICATION_REQUIRED" }), { status: 403 }),
    "fallback",
    "en",
  );
  assert.equal(failure.code, "REAUTHENTICATION_REQUIRED");
  assert.notEqual(failure.message, "fallback");

  const arabic = await operatorResponseFailure(
    new Response(JSON.stringify({ code: "REAUTHENTICATION_REQUIRED" }), { status: 403 }),
    "fallback",
    "ar",
  );
  assert.equal(arabic.code, "REAUTHENTICATION_REQUIRED");
  assert.notEqual(arabic.message, failure.message);
});

test("same-document navigation confirms only when an unsaved surface is present", () => {
  const calls: string[] = [];
  const clean = { querySelector: () => null } as unknown as Pick<Document, "querySelector">;
  const dirty = { querySelector: () => ({}) } as unknown as Pick<Document, "querySelector">;
  const confirm = (message: string) => { calls.push(message); return false; };
  assert.equal(confirmUnsavedNavigation("leave?", clean, confirm), true);
  assert.equal(confirmUnsavedNavigation("leave?", dirty, confirm), false);
  assert.deepEqual(calls, ["leave?"]);
});

test("automatic refresh pauses only for active editing surfaces", () => {
  const selectors: string[] = [];
  const cleanForm = {
    querySelector: (selector: string) => { selectors.push(selector); return null; },
  } as unknown as Pick<Document, "querySelector">;
  const activeEditor = {
    querySelector: () => ({}),
  } as unknown as Pick<Document, "querySelector">;
  assert.equal(shouldPauseAutomaticRefresh(cleanForm), false);
  assert.equal(shouldPauseAutomaticRefresh(activeEditor), true);
  assert.deepEqual(selectors, [
    '[data-unsaved="true"], dialog[open] form, [contenteditable="true"]',
  ]);
});

test("latest-request fence rejects a result after inputs change", async () => {
  const fence = createLatestRequestFence();
  const first = fence.begin();
  const deferred = Promise.resolve("old result");
  fence.invalidate();
  assert.equal(fence.isCurrent(first), false);
  assert.equal(await deferred, "old result");
  const second = fence.begin();
  assert.equal(fence.isCurrent(second), true);
});

test("ordinary review evidence is explicitly allowlisted while diagnostics remain available", () => {
  const metadata = {
    reference_count: 3,
    media_type: "image/jpeg",
    retry_requires_confirmation: true,
    error_codes: ["provider-secret-code"],
    provider_status: "opaque-provider-state",
    action_key: "shipment.update",
    reprocess_error_code: "INTERNAL_FAILURE",
  };
  assert.deepEqual(visibleReviewMetadata(metadata, false), [
    ["reference_count", 3],
    ["media_type", "image/jpeg"],
    ["retry_requires_confirmation", true],
  ]);
  assert.deepEqual(visibleReviewMetadata(metadata, true), Object.entries(metadata));
});

test("review notification dedupe prefers the friendly ticket number", () => {
  const failed = [{ ticket_number: "#91022" }];
  const reviews = [
    { id: "same", zammad_ticket_id: "22", ticket_number: "91022" },
    { id: "other", zammad_ticket_id: "23", ticket_number: "91023" },
    { id: "ticketless" },
  ];
  assert.deepEqual(unmatchedReviewItems(failed, reviews).map((row) => row.id), ["other", "ticketless"]);
});
