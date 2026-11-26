// Component UI proof with synthetic requests/devices only. No provider or backend acceptance.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const base = process.env.WASALX_STORYBOOK_URL ?? "http://127.0.0.1:6227";
const output = process.env.WASALX_SYNTHETIC_UI_OUTPUT ?? "output/playwright/inbox";
const A = "41000000-0000-4000-8000-000000000001", B = "41000000-0000-4000-8000-000000000002";
const M = "51000000-0000-4000-8000-000000000001", OLD = "51000000-0000-4000-8000-000000000002";
const MEDIA = "51000000-0000-4000-8000-000000000003", BM = "51000000-0000-4000-8000-000000000004";
const NEWEST = "51000000-0000-4000-8000-000000000005";
const ANCIENT = "51000000-0000-4000-8000-000000000006";
const stamp = "2026-10-18T09:00:00.000Z";
const recoveryKey = "wasalx:group-receipts:storybook:group-ui:synthetic-operator";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const summary = [];

async function translations(locale) {
  const source = await readFile(`lib/i18n/messages/${locale}/cases.ts`, "utf8");
  const values = Object.fromEntries([...source.matchAll(/"([^"]+)":\s*("(?:[^"\\]|\\.)*")/gu)].map(match => [match[1], JSON.parse(match[2])]));
  return (key, vars = {}) => {
    assert.equal(typeof values[key], "string", `missing test translation ${locale}:${key}`);
    return values[key].replace(/\{([^}]+)\}/gu, (_, name) => String(vars[name] ?? `{${name}}`));
  };
}

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function message(id, text, extra = {}) {
  return { id, participant_name: "Ahmed", sender_phone: "12025550142", message_text: text,
    provider_timestamp: stamp, from_me: false, latest_mutation: null, quote_allowed: true, ticket_creatable: true,
    quoted_message: null, delivery_state: null, delivery_hold_reason: null, reaction_active_emoji: null,
    reaction_delivery_state: null, media_kind: null, media_filename: null, media_mime_type: null, media_available: false, ...extra };
}

async function fixture(page) {
  const calls = [], writes = [], receipts = new Map(), failNext = new Map(), revoked = new Set(), held = [];
  const groups = [A, B].map((id, index) => ({ id, name: index ? "Operations B" : "Customers A", access_scope: "MY", unread_count: 2,
    send_available: true, reactions_available: true, media_capabilities: { accepted: [
      { mime_type: "text/plain", maximum_bytes: 100000 }, { mime_type: "audio/webm", maximum_bytes: 100000 },
    ], voice_recording: true, maximum_files: 5, maximum_total_bytes: 200000 } }));
  const messages = new Map([[A, [message(M, "Order A needs a delivery update.", {
    quoted_message: { id: OLD, author: "Ahmed", text: "Earlier original customer request." },
  }), message(MEDIA, "Photo for order A", {
    provider_timestamp: "2026-10-18T08:59:00.000Z",
    media_kind: "image", media_filename: "customer.png", media_mime_type: "image/png", media_available: true,
  })]], [B, [message(BM, "Independent operations B request.")]]]);
  const tickets = [{ ticket_number: "1042", title: "Delivery update", owner: "Maya", team: "Customer support",
    state_category: "OPEN", links: [{ message_id: OLD }] }];
  const state = { calls, writes, receipts, failNext, revoked, messages, uploads: [], uploadAttempts: 0, failUploadAt: 0, waitForForbiddenShowBody: false, mediaStatus: 200, sourceDenied: false,
    hold(operation, predicate = () => true) { const gate = deferred(); held.push({ operation, predicate, gate }); return gate; },
    count(operation) { return calls.filter(call => call.operation === operation).length; },
    last(operation) { return [...calls].reverse().find(call => call.operation === operation); } };
  await page.route("**/api/inbox/group-media", route => {
    const status = state.mediaStatus; state.mediaStatus = 200;
    return status === 200 ? route.fulfill({ status, contentType: "image/png", body: png })
      : route.fulfill({ status, json: { code: "ACCESS_DENIED" } });
  });
  await page.route("**/api/inbox/group-upload", async route => {
    state.uploadAttempts++;
    if (state.uploadAttempts === state.failUploadAt) return route.fulfill({ status: 503, json: { code: "UPLOAD_UNAVAILABLE" } });
    const body = route.request().postDataBuffer().toString("utf8");
    const filename = /filename="([^"]+)"/u.exec(body)?.[1];
    assert.ok(filename, "multipart file has a filename");
    const item = { id: String(700 + state.uploads.length), filename, mime_type: filename.endsWith("webm") ? "audio/webm" : "text/plain", size: 4 };
    state.uploads.push(item);
    return route.fulfill({ status: 200, json: { items: [item] } });
  });
  await page.route("**/api/inbox", async route => {
    const { operation, input } = route.request().postDataJSON();
    calls.push({ operation, input: structuredClone(input) });
    const hold = held.findIndex(item => item.operation === operation && item.predicate(input));
    if (hold >= 0) await held.splice(hold, 1)[0].gate.promise;
    const reply = value => route.fulfill({ status: 200, json: value });
    if (input.group_id && revoked.has(input.group_id)) {
      if (operation === "GROUP_CHECK" && state.waitForForbiddenShowBody)
        await page.waitForFunction(() => window.__groupUi.forbiddenShowBodies > 0, undefined, { timeout: 5000 });
      return route.fulfill({ status: 403, json: { code: "GROUP_ACCESS_DENIED", group_id: input.group_id } });
    }
    switch (operation) {
      case "CHECK": return reply({ allowed: true });
      case "LIST": return reply({ items: [{ id: "42", number: "1042", title: "Delivery update", customer: "Customer", team: "Customer support", team_id: "2",
        owner_id: "12", owner: "Maya", updated_at: stamp, closed: false, state: "open", channel: "whatsapp" }], next_cursor: null });
      case "SHOW": return reply({ id: "42", number: "1042", title: "Delivery update", customer: "Customer", team: "Customer support", team_id: "2", owner_id: "12", owner: "Maya",
        updated_at: stamp, closed: false, state: "open", channel: "whatsapp", can_update: true, can_reply: true, owner_team_id: "2", owners: [], teams: [], states: [],
        upload_constraints: { accepted: null, maximum_file_bytes: 50000000, maximum_files: 10, maximum_total_bytes: 50000000 } });
      case "ARTICLES": return reply({ items: [{ id: "901", has_source: true, body: "Earlier original customer request.", body_complete: true, total_characters: 34,
        body_sha256: "0".repeat(64), internal: false, author: "Customer", sender: "Customer", created_at: stamp, attachments: [] }], next_cursor: null });
      case "SOURCE_CONTEXT": assert.deepEqual(input, { ticket_id: "42", article_id: "901" });
        return state.sourceDenied ? route.fulfill({ status: 404, json: { code: "UNAVAILABLE" } }) : reply({ group_id: A, message_id: OLD });
      case "GROUP_CHECK": return reply({ allowed: true });
      case "GROUP_LIST": return reply({ items: groups.filter(group => !revoked.has(group.id) &&
        (input.scope !== "TEAM" || group.id === B)), next_cursor: null });
      case "GROUP_SHOW": return reply(groups.find(group => group.id === input.group_id));
      case "GROUP_MESSAGES": return reply({ items: input.before ? [input.before === OLD
        ? message(ANCIENT, "Customer request before the historical source.", { provider_timestamp: "2026-10-18T07:00:00.000Z" })
        : message(OLD, "Earlier original customer request.", { provider_timestamp: "2026-10-18T08:00:00.000Z" })] : messages.get(input.group_id),
        next_cursor: input.before || input.group_id !== A ? null : MEDIA });
      case "GROUP_CONTEXT": return reply({ items: [message(input.message_id, "Earlier original customer request.", {
        provider_timestamp: "2026-10-18T08:00:00.000Z",
      })], next_cursor: OLD });
      case "GROUP_TICKETS": return reply({ items: input.group_id === A && input.state !== "CLOSED" ? tickets : [], next_cursor: null });
      case "GROUP_TEAMS": return reply([{ id: "2", name: "Customer support" }]);
      case "GROUP_PARTICIPANTS": return reply([
        { id: "44123@lid", name: "Resolved phone", phone: "12025550142", mention_token: "12025550142" },
        { id: "44123@lid", name: "Same participant alias", phone: "12025550142", mention_token: "12025550142" },
      ]);
      case "GROUP_READ": return reply({ acknowledged: true });
      case "GROUP_REMOVE_UPLOAD": return reply({ removed: true });
      case "GROUP_RECEIPT": case "GROUP_TICKET_RECEIPT": {
        const value = receipts.get(input.operation_id) ?? { state: "UNKNOWN" };
        if (input.action === "CANCEL_IF_UNADMITTED" && value.cancel) return reply(value.cancel);
        return reply(value);
      }
      case "GROUP_REPAIR_TICKET_LINK": {
        const value = { state: "COMPLETE", ticket_number: "1045" };
        receipts.set(input.operation_id, value); return reply(value);
      }
      default: {
        assert.ok(["GROUP_SEND", "GROUP_REACTION", "GROUP_CREATE_TICKET", "GROUP_LINK_TICKET"].includes(operation), `unhandled fixture operation ${operation}`);
        assert.equal(writes.some(write => write.input.request_token === input.request_token), false, "UI never replays an uncertain write");
        writes.push({ operation, input: structuredClone(input) });
        const fail = failNext.get(operation); failNext.delete(operation);
        const saga = operation === "GROUP_CREATE_TICKET" || operation === "GROUP_LINK_TICKET";
        receipts.set(input.request_token, fail ?? (saga ? { state: "COMPLETE", ticket_number: "1045" } : { state: "ADMITTED" }));
        if (fail) return route.abort("failed");
        return reply({ accepted: true, ...(saga ? { ticket_number: "1045" } : {}) });
      }
    }
  });
  return state;
}

async function instrumentation(context) {
  await context.addInitScript(() => {
    const stats = { opened: [], revoked: [], tracksStopped: 0, microphones: 0, deferMicrophone: false, resolveMicrophone: null };
    Object.assign(stats, { deferForbiddenShow: false, forbiddenShowBodies: 0, abortedForbiddenShowBodies: 0, holdMediaBody: null, heldMediaBodies: 0, releaseMediaBody: null });
    window.__groupUi = stats;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (resource, init) => {
      const response = await originalFetch(resource, init);
      const mediaBody = stats.holdMediaBody;
      if (String(resource).endsWith("/api/inbox/group-media") && mediaBody) {
        stats.holdMediaBody = null;
        return new Proxy(response, { get(target, property) {
          if (property === mediaBody) return async () => {
            // Decode first, then hold the continuation even after abort. This tests the consumer fence.
            const value = await target[mediaBody]();
            stats.heldMediaBodies++;
            return new Promise(resolve => { stats.releaseMediaBody = () => { stats.releaseMediaBody = null; resolve(value); }; });
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }
      let operation;
      try { operation = JSON.parse(init?.body ?? "{}").operation; } catch { /* Binary uploads are not JSON operations. */ }
      if (operation !== "GROUP_SHOW" || response.status !== 403 || !stats.deferForbiddenShow) return response;
      return new Proxy(response, { get(target, property) {
        if (property === "json") return () => new Promise((resolve, reject) => {
          stats.forbiddenShowBodies++;
          const cancel = () => { stats.abortedForbiddenShowBodies++; reject(new DOMException("Synthetic body aborted", "AbortError")); };
          if (init?.signal?.aborted) cancel();
          else init?.signal?.addEventListener("abort", cancel, { once: true });
        });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); stats.opened.push(url); return url; };
    URL.revokeObjectURL = url => { stats.revoked.push(url); return revoke(url); };
    const stream = () => ({ getTracks: () => [{ stop: () => { stats.tracksStopped++; } }] });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => { stats.microphones++; if (stats.deferMicrophone) return new Promise(resolve => { stats.resolveMicrophone = () => resolve(stream()); }); return stream(); },
    } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      state = "inactive";
      constructor() {}
      start() { this.state = "recording"; }
      stop() { if (this.state === "inactive") return; this.state = "inactive"; queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["synthetic audio"], { type: "audio/webm" }) }); this.onstop?.();
      }); }
    };
  });
}

const browser = await chromium.launch({ ...(process.env.WASALX_VISUAL_BROWSER_PATH ? { executablePath: process.env.WASALX_VISUAL_BROWSER_PATH } : {}), headless: true });
await mkdir(output, { recursive: true });
try {
  for (const locale of ["en", "ar"]) {
    const t = await translations(locale);
    const context = await browser.newContext({ locale: locale === "ar" ? "en-US" : "ar-SA", viewport: { width: 1440, height: 1000 } });
    await instrumentation(context);
    const page = await context.newPage(), state = await fixture(page), pageErrors = [];
    await page.clock.install();
    page.on("pageerror", error => pageErrors.push(error.message));
    const story = `${base}/iframe.html?id=product-group-inbox--${locale === "ar" ? "arabic" : "english"}`;
    const group = () => page.locator(".wx-group");
    const button = key => group().getByRole("button", { name: t(key), exact: true });
    const row = id => group().locator(`[data-message-id="${id}"]`);
    const choose = async (name, writable = true) => {
      if (await group().locator(".wx-group-back").isVisible()) await button("groups.back").click();
      await group().getByRole("button", { name: new RegExp(name, "u") }).click();
      await expect(group().getByRole("heading", { name })).toBeVisible();
      if (writable) await expect(page.locator("#wx-group-message")).toBeEnabled();
    };
    const writes = operation => state.writes.filter(write => write.operation === operation);
    const assertNoNewReads = (count, start, phase) => assert.equal(state.count("GROUP_READ"), count,
      `source context must not acknowledge unseen newer messages: ${JSON.stringify({ locale, phase,
        calls: state.calls.slice(start).filter(call => ["SOURCE_CONTEXT", "GROUP_CONTEXT", "GROUP_MESSAGES", "GROUP_SHOW", "GROUP_READ"].includes(call.operation)) })}`);
    const exerciseReadCallbacks = () => page.evaluate(async () => {
      document.querySelector(".wx-group-history")?.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("focus"));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.goto(story, { waitUntil: "networkidle" });
    await choose("Customers A");
    await expect(group().getByRole("heading", { name: "Customers A" })).toBeFocused();
    await page.locator("#wx-group-message").fill("Draft A");
    await row(M).getByRole("button", { name: t("groups.quoteReply"), exact: true }).click();
    await choose("Operations B");
    await page.locator("#wx-group-message").fill("Draft B");
    await choose("Customers A");
    await expect(page.locator("#wx-group-message")).toHaveValue("Draft A");
    await expect(button("groups.cancelQuote")).toBeVisible();

    // A later upload failure must keep the file already acknowledged by the server.
    state.failUploadAt = state.uploadAttempts + 3;
    await expect(page.locator("#wx-group-files")).toBeHidden();
    await expect(button("attachments.choose")).toHaveAccessibleDescription(t("attachments.none"));
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button("attachments.choose").press("Space")]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles([
      { name: "kept.txt", mimeType: "text/plain", buffer: Buffer.from("keep") },
      { name: "remove.txt", mimeType: "text/plain", buffer: Buffer.from("drop") },
      { name: "failed.txt", mimeType: "text/plain", buffer: Buffer.from("fail") },
    ]);
    await expect(group().getByRole("button", { name: t("groups.removeAttachment", { filename: "kept.txt" }), exact: true })).toBeVisible();
    await expect(group().getByRole("button", { name: t("groups.removeAttachment", { filename: "failed.txt" }), exact: true })).toHaveCount(0);
    await expect(button("attachments.choose")).not.toHaveAccessibleDescription(t("attachments.none"));
    assert.equal(state.uploads.length, 2);
    const removeFile = group().getByRole("button", { name: t("groups.removeAttachment", { filename: "remove.txt" }), exact: true });
    await removeFile.click();
    await expect(removeFile).toHaveCount(0);
    await expect(group().getByRole("button", { name: t("groups.removeAttachment", { filename: "kept.txt" }), exact: true })).toBeVisible();
    await button("groups.mention").click();
    await group().getByRole("button", { name: /Resolved phone/u }).click();
    await expect(page.locator("#wx-group-message")).toHaveValue("Draft A @12025550142 ");
    await button("groups.mention").click();
    await expect(group().getByRole("button", { name: /Same participant alias/u })).toBeDisabled();
    await button("groups.mention").click();
    // Numeric suffix lookalikes must not keep the original participant identity selected.
    await page.locator("#wx-group-message").fill("Draft A @120255501420");
    await expect(group().getByRole("button", { name: t("groups.removeMention", { name: "Resolved phone" }), exact: true })).toHaveCount(0);
    await button("groups.mention").click();
    await group().getByRole("button", { name: /Resolved phone/u }).click();
    await button("groups.send").click();
    await expect.poll(() => writes("GROUP_SEND").length).toBe(1);
    await expect(page.locator("#wx-group-message")).toHaveValue("");
    assert.deepEqual(writes("GROUP_SEND")[0].input.mentions, ["44123@lid"]);
    assert.equal(writes("GROUP_SEND")[0].input.reply_to_message_id, M);
    assert.deepEqual(writes("GROUP_SEND")[0].input.upload_store_ids, ["700"]);
    await expect(button("groups.cancelQuote")).toHaveCount(0);

    // Late history from A must never appear under B.
    const olderGate = state.hold("GROUP_MESSAGES", input => input.group_id === A && Boolean(input.before));
    await button("groups.older").click();
    await expect.poll(() => state.calls.some(call => call.operation === "GROUP_MESSAGES" && call.input.before)).toBe(true);
    await group().getByRole("button", { name: /Operations B/u }).click();
    await expect(group().getByText("Independent operations B request.", { exact: true })).toBeVisible();
    olderGate.resolve();
    await expect(page.locator("#wx-group-message")).toBeEnabled();
    await expect(group().getByText("Earlier original customer request.", { exact: true })).toHaveCount(0);
    await choose("Customers A");
    const listGate = state.hold("GROUP_LIST", input => input.scope === "TEAM");
    await page.locator("#wx-group-scope").selectOption("TEAM");
    await expect.poll(() => state.last("GROUP_LIST").input.scope).toBe("TEAM");
    await expect(group().getByRole("heading", { name: "Customers A" })).toBeVisible();
    await page.locator("#wx-group-scope").selectOption("ALL");
    await expect.poll(() => state.last("GROUP_LIST").input.scope).toBe("ALL");
    listGate.resolve();
    await expect(group().getByRole("button", { name: /Customers A/u })).toBeVisible();

    // Unknown send: LOOKUP cannot unlock UNKNOWN; cancellation needs a terminal receipt.
    state.failNext.set("GROUP_SEND", { state: "UNKNOWN", cancel: { state: "CANCELLED", terminal: false } });
    await page.locator("#wx-group-message").fill("Unknown send A");
    await button("groups.send").click();
    await expect(button("groups.checkSubmission")).toBeVisible();
    const sendToken = writes("GROUP_SEND").at(-1).input.request_token;
    const recovery = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), recoveryKey);
    assert.equal(recovery[0].operation_id, sendToken);
    assert.equal(JSON.stringify(recovery).includes("Unknown send A"), false, "recovery never stores customer text");
    await button("groups.checkSubmission").click();
    await expect(page.locator("#wx-group-message")).toBeDisabled();
    await button("groups.cancelIfUnadmitted").click();
    await expect(button("groups.checkSubmission")).toBeVisible();
    state.receipts.set(sendToken, { state: "UNKNOWN", cancel: { state: "CANCELLED", terminal: true } });
    await button("groups.cancelIfUnadmitted").click();
    await expect(page.locator("#wx-group-message")).toBeEnabled();
    await expect(page.locator("#wx-group-message")).toHaveValue("Unknown send A");
    assert.equal(writes("GROUP_SEND").length, 2, "receipt checks/cancel never dispatch another send");

    state.failNext.set("GROUP_REACTION", { state: "UNKNOWN" });
    await row(M).getByRole("combobox", { name: t("groups.react"), exact: true }).selectOption("👍");
    await expect(button("groups.checkSubmission")).toBeVisible();
    const reactionToken = writes("GROUP_REACTION").at(-1).input.request_token;
    await button("groups.checkSubmission").click();
    state.receipts.set(reactionToken, { state: "ADMITTED" });
    await button("groups.checkSubmission").click();
    await expect(button("groups.checkSubmission")).toHaveCount(0);
    assert.equal(writes("GROUP_REACTION").length, 1);

    // A partially completed create survives reload and repairs its existing link exactly once.
    state.failNext.set("GROUP_CREATE_TICKET", { state: "PARTIAL", ticket_number: "1045" });
    await row(M).getByRole("button", { name: t("groups.createTicket"), exact: true }).click();
    await expect(page.locator("#wx-group-ticket-team")).toHaveValue("2");
    await page.getByRole("dialog").getByRole("button", { name: t("groups.save"), exact: true }).click();
    await expect(button("groups.checkSubmission")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: t("groups.cancel"), exact: true }).click();
    await page.reload({ waitUntil: "networkidle" });
    await choose("Customers A", false);
    await button("groups.checkSubmission").click();
    await expect(button("groups.finishTicketLink")).toBeVisible();
    await button("groups.finishTicketLink").click();
    await expect(button("groups.checkSubmission")).toHaveCount(0);
    assert.equal(writes("GROUP_CREATE_TICKET").length, 1);
    assert.equal(state.count("GROUP_REPAIR_TICKET_LINK"), 1);
    state.failNext.set("GROUP_LINK_TICKET", { state: "UNKNOWN", cancel: { state: "NOT_APPLIED", terminal: true } });
    await row(M).getByRole("button", { name: t("groups.linkTicket"), exact: true }).click();
    await page.locator("#wx-group-ticket-number").fill("1042");
    await page.getByRole("dialog").getByRole("button", { name: t("groups.save"), exact: true }).click();
    await expect(button("groups.checkSubmission")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: t("groups.cancel"), exact: true }).click();
    await button("groups.checkSubmission").click();
    await button("groups.cancelTicketIfUnadmitted").click();
    await expect(button("groups.checkSubmission")).toHaveCount(0);
    assert.equal(writes("GROUP_LINK_TICKET").length, 1);

    // Context jump and related-ticket round trip preserve the group draft.
    await page.locator("#wx-group-message").fill("Keep across Tickets pane");
    await group().getByText(t("groups.relatedTickets"), { exact: true }).click();
    const relatedContext = state.hold("GROUP_CONTEXT", input => input.group_id === A && input.message_id === OLD);
    const relatedReads = state.count("GROUP_READ"), relatedCalls = state.calls.length, relatedContexts = state.count("GROUP_CONTEXT");
    await button("groups.sourceMessage").click();
    await expect.poll(() => state.count("GROUP_CONTEXT")).toBe(relatedContexts + 1);
    await exerciseReadCallbacks();
    assertNoNewReads(relatedReads, relatedCalls, "related-ticket context pending");
    relatedContext.resolve();
    await expect(row(OLD)).toBeFocused();
    await exerciseReadCallbacks();
    assertNoNewReads(relatedReads, relatedCalls, "related-ticket context loaded");
    const historicalPage = page.waitForResponse(response => response.url().endsWith("/api/inbox")
      && response.request().postDataJSON().operation === "GROUP_MESSAGES" && response.request().postDataJSON().input.before === OLD);
    await button("groups.older").click();
    await historicalPage;
    await expect(row(ANCIENT)).toBeVisible();
    await expect(button("groups.older")).toHaveCount(0);
    await exerciseReadCallbacks();
    await expect(button("groups.latest")).toBeVisible();
    await expect(row(OLD)).toHaveAttribute("data-source-target", "true");
    assertNoNewReads(relatedReads, relatedCalls, "historical older page");
    await button("groups.latest").click();
    await group().getByRole("button", { name: /#1042/u }).click();
    const groupsMode = page.getByRole("button", { name: t("inbox.groupConversations"), exact: true });
    await expect(groupsMode).toHaveAttribute("aria-pressed", "false");
    const readsWhileHidden = state.count("GROUP_READ"), groupChecksWhileHidden = state.count("GROUP_CHECK");
    const ticketCheck = page.waitForResponse(response => response.url().endsWith("/api/inbox") && response.request().postDataJSON().operation === "CHECK");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await ticketCheck;
    assert.equal(state.count("GROUP_READ"), readsWhileHidden, "hidden group pane never advances read cursor");
    assert.equal(state.count("GROUP_CHECK"), groupChecksWhileHidden, "hidden group pane does not poll");
    // A stale article hint cannot bypass current source grants; the ticket draft stays intact.
    const source = page.locator('[data-article-id="901"]').getByRole("button", { name: t("groups.sourceMessage"), exact: true });
    await expect(source).toBeVisible();
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    await page.locator("#inbox-search").fill("Delivery");
    state.sourceDenied = true;
    const sourceDenied = page.waitForResponse(response => response.url().endsWith("/api/inbox")
      && response.request().postDataJSON().operation === "SOURCE_CONTEXT" && response.status() === 404);
    await source.click();
    await sourceDenied;
    await expect(page.getByText(t("inbox.sourceUnavailable"), { exact: true })).toBeVisible();
    const sourceListGate = state.hold("LIST"), sourceListCalls = state.count("LIST");
    const listFinished = page.waitForResponse(response => response.url().endsWith("/api/inbox") && response.request().postDataJSON().operation === "LIST");
    await page.clock.runFor(300);
    await expect.poll(() => state.count("LIST")).toBe(sourceListCalls + 1);
    await expect(page.getByText(t("inbox.sourceUnavailable"), { exact: true })).toBeVisible();
    sourceListGate.resolve();
    await (await listFinished).finished();
    await expect(page.getByText(t("inbox.sourceUnavailable"), { exact: true })).toBeVisible();
    await page.clock.resume();
    await expect(groupsMode).toHaveAttribute("aria-pressed", "false");
    state.sourceDenied = false;
    const sourceGate = state.hold("SOURCE_CONTEXT"), sourceCallsBefore = state.count("SOURCE_CONTEXT");
    await source.click();
    await expect.poll(() => state.count("SOURCE_CONTEXT")).toBe(sourceCallsBefore + 1);
    await groupsMode.click();
    await choose("Operations B");
    const ignoredSource = page.waitForResponse(response => response.url().endsWith("/api/inbox") && response.request().postDataJSON().operation === "SOURCE_CONTEXT");
    sourceGate.resolve(); await ignoredSource;
    await expect(group().getByRole("heading", { name: "Operations B" })).toBeFocused();
    await expect(row(OLD)).toHaveCount(0);
    await page.getByRole("button", { name: t("inbox.conversations"), exact: true }).click();
    await expect(source).toBeEnabled();
    const contextsBeforeSource = state.count("GROUP_CONTEXT"), readsBeforeSource = state.count("GROUP_READ");
    const sourceCallsStart = state.calls.length;
    const heldSourceContext = state.hold("GROUP_CONTEXT", input => input.group_id === A && input.message_id === OLD);
    await source.click();
    await expect(groupsMode).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => state.count("GROUP_CONTEXT")).toBe(contextsBeforeSource + 1);
    await exerciseReadCallbacks();
    assertNoNewReads(readsBeforeSource, sourceCallsStart, "ticket source context pending");
    heldSourceContext.resolve();
    await expect(row(OLD)).toBeFocused();
    await expect(row(OLD)).toHaveAttribute("data-source-target", "true");
    assert.equal(state.count("GROUP_CONTEXT"), contextsBeforeSource + 1);
    assert.deepEqual(state.last("GROUP_CONTEXT").input, { group_id: A, message_id: OLD });
    await exerciseReadCallbacks();
    assertNoNewReads(readsBeforeSource, sourceCallsStart, "ticket source context loaded");
    await expect(page.locator("#wx-group-message")).toHaveValue("Keep across Tickets pane");
    const latestCallsStart = state.calls.length;
    const sourceLatestRead = page.waitForResponse(response => response.url().endsWith("/api/inbox")
      && response.request().postDataJSON().operation === "GROUP_READ" && response.request().postDataJSON().input.group_id === A
      && response.request().postDataJSON().input.message_id === M);
    await button("groups.latest").click();
    await (await sourceLatestRead).finished();
    await expect(row(M)).toBeVisible();
    await exerciseReadCallbacks();
    assert.ok(state.calls.slice(latestCallsStart).some(call => call.operation === "GROUP_READ" && call.input.group_id === A && call.input.message_id === M),
      "Latest must acknowledge its newly loaded current view before the quoted-context regression");

    const quoteContext = state.hold("GROUP_CONTEXT", input => input.group_id === A && input.message_id === OLD);
    const quoteReads = state.count("GROUP_READ"), quoteCalls = state.calls.length, quoteContexts = state.count("GROUP_CONTEXT");
    await row(M).getByRole("button", { name: /Ahmed.*Earlier original customer request/u }).click();
    await expect.poll(() => state.count("GROUP_CONTEXT")).toBe(quoteContexts + 1);
    await exerciseReadCallbacks();
    assertNoNewReads(quoteReads, quoteCalls, "quoted context pending");
    quoteContext.resolve();
    await expect(row(OLD)).toBeFocused();
    await exerciseReadCallbacks();
    assertNoNewReads(quoteReads, quoteCalls, "quoted context loaded");
    const contextRefresh = () => page.waitForResponse(response => response.url().endsWith("/api/inbox")
      && response.request().postDataJSON().operation === "GROUP_CONTEXT" && response.request().postDataJSON().input.group_id === A
      && response.request().postDataJSON().input.message_id === OLD);
    const reactionsBeforeContext = writes("GROUP_REACTION").length;
    const reactionContext = contextRefresh();
    await row(OLD).getByRole("combobox", { name: t("groups.react"), exact: true }).selectOption("👍");
    await (await reactionContext).finished();
    await exerciseReadCallbacks();
    await expect(row(OLD)).toHaveAttribute("data-source-target", "true");
    assertNoNewReads(quoteReads, quoteCalls, "historical reaction refresh");
    state.failNext.set("GROUP_REACTION", { state: "UNKNOWN" });
    await row(OLD).getByRole("combobox", { name: t("groups.react"), exact: true }).selectOption("👍");
    await expect(button("groups.checkSubmission")).toBeVisible();
    const historicalReaction = writes("GROUP_REACTION").at(-1).input.request_token;
    const reloadContext = contextRefresh();
    await button("groups.reload").click();
    await (await reloadContext).finished();
    await exerciseReadCallbacks();
    await expect(row(OLD)).toHaveAttribute("data-source-target", "true");
    assertNoNewReads(quoteReads, quoteCalls, "historical error reload");
    state.receipts.set(historicalReaction, { state: "ADMITTED" });
    const recoveryContext = contextRefresh();
    await button("groups.checkSubmission").click();
    await (await recoveryContext).finished();
    await exerciseReadCallbacks();
    await expect(row(OLD)).toHaveAttribute("data-source-target", "true");
    await expect(button("groups.latest")).toBeVisible();
    assertNoNewReads(quoteReads, quoteCalls, "historical receipt recovery");
    assert.equal(writes("GROUP_REACTION").length, reactionsBeforeContext + 2, "reload and receipt recovery never replay a reaction");
    state.messages.get(A).unshift(message(NEWEST, "New customer message after the historical context.", { provider_timestamp: "2026-10-18T09:01:00.000Z" }));
    await button("groups.latest").click();
    await expect(row(NEWEST)).toBeVisible();
    await expect.poll(() => state.last("GROUP_READ")?.input).toEqual({ group_id: A, message_id: NEWEST });
    assert.equal(state.calls.slice(quoteCalls).some(call => call.operation === "GROUP_READ" && call.input.message_id === OLD), false,
      "historical source messages are not acknowledged while Latest resumes current-message reads");

    await group().getByText(t("groups.relatedTickets"), { exact: true }).click();
    const staleContext = state.hold("GROUP_CONTEXT", input => input.group_id === A && input.message_id === OLD);
    const contextsBeforeStale = state.count("GROUP_CONTEXT");
    await button("groups.sourceMessage").click();
    await expect.poll(() => state.count("GROUP_CONTEXT")).toBe(contextsBeforeStale + 1);
    await group().getByRole("button", { name: /Operations B/u }).click();
    await expect(group().getByRole("heading", { name: "Operations B" })).toBeFocused();
    staleContext.resolve();
    await expect(row(OLD)).toHaveCount(0);
    await expect(group().getByRole("heading", { name: "Operations B" })).toBeFocused();
    await choose("Customers A");

    // Media object URLs and synthetic microphone tracks are released when the pane hides.
    await group().getByRole("button", { name: t("groups.loadMedia", { filename: "customer.png" }), exact: true }).click();
    await expect(group().getByRole("img", { name: t("groups.imageAttachment") })).toBeVisible();
    await button("groups.recordVoice").click();
    await expect(button("groups.discardVoice")).toBeVisible();
    const uploadsBeforeHide = state.uploadAttempts;
    await page.getByRole("button", { name: t("inbox.conversations"), exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__groupUi.tracksStopped)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.__groupUi.opened.every(url => window.__groupUi.revoked.includes(url)))).toBe(true);
    assert.equal(state.uploadAttempts, uploadsBeforeHide, "hiding discards recording rather than uploading it");
    await groupsMode.click();

    await expect(group().getByRole("heading", { name: "Customers A" })).toBeFocused();

    // A media body finishing after hide/reopen cannot revoke access or replace a fresh object URL.
    const reopenGroupMedia = async () => {
      const requests = ["GROUP_SHOW", "GROUP_MESSAGES"].map(operation => page.waitForRequest(request =>
        request.url().endsWith("/api/inbox") && request.postDataJSON().operation === operation && request.postDataJSON().input.group_id === A));
      await groupsMode.click();
      for (const request of await Promise.all(requests)) {
        const response = await request.response();
        assert.ok(response?.ok(), "fresh group activation must complete before loading media");
        await response.finished();
      }
      await expect(group().getByRole("heading", { name: "Customers A" })).toBeFocused();
    };
    for (const bodyKind of ["json", "blob"]) {
      await page.getByRole("button", { name: t("inbox.conversations"), exact: true }).click();
      await reopenGroupMedia();
      const heldBefore = await page.evaluate(() => window.__groupUi.heldMediaBodies);
      state.mediaStatus = bodyKind === "json" ? 403 : 200;
      await page.evaluate(kind => { window.__groupUi.holdMediaBody = kind; }, bodyKind);
      await group().getByRole("button", { name: t("groups.loadMedia", { filename: "customer.png" }), exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__groupUi.heldMediaBodies)).toBe(heldBefore + 1);
      await page.getByRole("button", { name: t("inbox.conversations"), exact: true }).click();
      await reopenGroupMedia();
      await group().getByRole("button", { name: t("groups.loadMedia", { filename: "customer.png" }), exact: true }).click();
      const image = group().getByRole("img", { name: t("groups.imageAttachment") });
      await expect(image).toBeVisible();
      const currentUrl = await image.getAttribute("src"), openedBeforeRelease = await page.evaluate(() => window.__groupUi.opened.length);
      await page.evaluate(async () => { window.__groupUi.releaseMediaBody(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await expect(image).toHaveAttribute("src", currentUrl);
      assert.equal(await page.evaluate(() => window.__groupUi.opened.length), openedBeforeRelease, "old body cannot allocate an unowned URL");
      await expect(page.locator("#wx-group-message")).toBeEnabled();
      await expect(group().getByRole("heading", { name: "Customers A" })).toBeVisible();
    }

    // A revoked group disappears; another authorized group remains independently usable.
    state.waitForForbiddenShowBody = true;
    await page.evaluate(() => { window.__groupUi.deferForbiddenShow = true; });
    state.revoked.add(A);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => page.evaluate(() => window.__groupUi.abortedForbiddenShowBodies)).toBeGreaterThan(0);
    await expect(group().getByText("Order A needs a delivery update.", { exact: true })).toHaveCount(0);
    await choose("Operations B");
    await page.locator("#wx-group-message").fill("Still authorized B");
    await button("groups.send").click();
    await expect(page.locator("#wx-group-message")).toHaveValue("");
    assert.equal(writes("GROUP_SEND").at(-1).input.group_id, B);

    // Both themes/locale layouts, mobile chooser focus and keyboard controls.
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await page.goto(`${story}&globals=theme:dark`, { waitUntil: "networkidle" });
        await choose("Operations B");
        await expect(group().getByRole("heading", { name: "Operations B" })).toBeFocused();
      }
      await page.evaluate(() => document.fonts.ready);
      for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844], ["zoom-equivalent", 720, 500]]) {
        await page.setViewportSize({ width, height });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${locale}:${theme}:${name}: overflow`);
        const ticketsMode = page.getByRole("button", { name: t("inbox.conversations"), exact: true });
        await ticketsMode.focus();
        await page.keyboard.press("Tab");
        await expect(groupsMode).toBeFocused();
        await expect(groupsMode).toHaveAttribute("aria-pressed", "true");
        await expect(groupsMode).toHaveCSS("display", "flex");
        await expect(groupsMode).toHaveCSS("align-items", "center");
        await expect(groupsMode).toHaveCSS("outline-width", "2px");
        await expect(groupsMode).toHaveCSS("outline-style", "solid");
        await page.screenshot({ path: `${output}/group-${locale}-${theme}-${name}.png`, fullPage: true });
        const accessibility = await new AxeBuilder({ page }).include(".wx-group").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        assert.deepEqual(accessibility.violations.map(item => ({ id: item.id, impact: item.impact })), [], `${locale}:${theme}:${name}: axe`);
      }
    }
    await button("groups.back").click();
    await expect(page.locator("#wx-group-scope")).toBeFocused();
    await page.keyboard.press("Tab");
    assert.equal(await group().locator(".wx-group-choice").evaluateAll(nodes => nodes.includes(document.activeElement)), true);
    await page.keyboard.press("Enter");
    await expect(group().getByRole("heading", { name: "Operations B" })).toBeFocused();
    assert.deepEqual(pageErrors, [], `${locale}: uncaught component errors`);
    summary.push({ locale, mode: "synthetic-component-ui", writes: state.writes.map(write => ({ operation: write.operation,
      request_token: write.input.request_token })), checks: state.calls.length, themes: ["light", "dark"], screenshots: ["desktop", "mobile", "zoom-equivalent"],
      untested: ["actual provider", "actual native gateway", "real microphone hardware", "human screen reader", "physical touch"] });
    await context.close();
  }
  for (const locale of ["en", "ar"]) {
    const t = await translations(locale), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), state = await fixture(page);
    await page.goto(`${base}/iframe.html?id=product-group-inbox--source-lifecycle-${locale === "ar" ? "arabic" : "english"}`, { waitUntil: "networkidle" });
    const group = page.locator(".wx-group");
    await group.getByRole("button", { name: /Customers A/u }).click();
    await expect(group.getByRole("heading", { name: "Customers A" })).toBeVisible();
    await group.getByText(t("groups.relatedTickets"), { exact: true }).click();
    await group.getByRole("button", { name: /#1042/u }).click();
    const source = page.locator('[data-article-id="901"]').getByRole("button", { name: t("groups.sourceMessage"), exact: true });
    await expect(source).toBeVisible();
    const held = state.hold("SOURCE_CONTEXT"); await source.click();
    await expect.poll(() => state.count("SOURCE_CONTEXT")).toBe(1);
    await page.locator('[data-source-harness="toggle"]').click();
    await expect(page.locator('[data-source-harness="outside"]')).toBeVisible();
    const response = page.waitForResponse(value => value.url().endsWith("/api/inbox") && value.request().postDataJSON().operation === "SOURCE_CONTEXT");
    held.resolve(); await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('[data-source-harness="navigation"]')).toHaveText("0");
    await expect(page.locator('[data-source-harness="outside"]')).toBeVisible();
    await expect(page.locator(".wx-group")).toHaveCount(0);
    await context.close();
  }
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), state = await fixture(page);
  await page.goto(`${base}/iframe.html?id=product-group-inbox--read-only`, { waitUntil: "networkidle" });
  assert.equal(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches), true);
  const switchButtons = page.locator(".wx-inbox-switch").getByRole("button");
  await expect(switchButtons).toHaveCount(2);
  for (const button of await switchButtons.all()) {
    await expect(button).toHaveCSS("min-inline-size", "44px");
    await expect(button).toHaveCSS("min-block-size", "44px");
  }
  await page.locator(".wx-group-choice").filter({ hasText: "Customers A" }).click();
  await expect(page.locator(".wx-group-header h2")).toHaveText("Customers A");
  await expect(page.locator("#wx-group-message")).toHaveCount(0);
  await expect(page.locator(".wx-group-messages .wx-group-actions")).toHaveCount(0);
  assert.equal(state.writes.length, 0);
  assert.equal(state.count("GROUP_READ"), 0, "read-only view does not advance team read markers");
  await context.close();
} finally { await browser.close(); }
await writeFile(`${output}/group-browser-proof.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log("Group component EN/AR draft, quote, mention, upload, recovery, navigation, cleanup and accessibility checks passed.");
