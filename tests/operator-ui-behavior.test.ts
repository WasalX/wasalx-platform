import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { ScrollRegion as ScrollRegionComponent } from "../app/tenant-ui.tsx";

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

type ScrollRegionProps = Parameters<typeof ScrollRegionComponent>[0];

// @ts-expect-error A scroll region needs an accessible name.
const unnamed: ScrollRegionProps = { className: "wrap" };
// @ts-expect-error A scroll region takes its name from one source.
const twoNames: ScrollRegionProps = { "aria-label": "Rates", "aria-labelledby": "rates-title" };
void unnamed; void twoNames;

test("ScrollRegion renders a named region that keyboard users can focus", async () => {
  const source = await readFile(new URL("../app/tenant-ui.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("tenant-ui.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ScrollRegion");
  assert.ok(declaration, "tenant-ui exports the shared ScrollRegion");
  const compiled = ts.transpileModule(declaration.getText(ast).replace(/^export /u, ""), { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
  const ScrollRegion = new Function("React", `${compiled};return ScrollRegion;`)(React) as typeof ScrollRegionComponent;
  const render = (props: ScrollRegionProps) => renderToStaticMarkup(React.createElement(ScrollRegion, props, "rows"));

  const labelled = render({ "aria-label": "Rates", className: "wrap" });
  assert.match(labelled, /^<div [^>]*role="region"[^>]*>rows<\/div>$/u);
  assert.match(labelled, /tabindex="0"/u);
  assert.match(labelled, /aria-label="Rates"/u);
  assert.match(labelled, /class="wrap"/u);
  const byHeading = render({ "aria-labelledby": "drawer-title" });
  assert.match(byHeading, /aria-labelledby="drawer-title"/u);
  assert.match(byHeading, /role="region"/u);
  // Callers cannot turn the region into something unfocusable or unnamed by role.
  const overridden = render({ "aria-label": "Rates", ...({ role: "presentation", tabIndex: -1 } as object) });
  assert.match(overridden, /role="region"/u);
  assert.match(overridden, /tabindex="0"/u);
});
