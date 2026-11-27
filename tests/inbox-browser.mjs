// Synthetic UI interaction proof only; native/backend/provider acceptance is a separate gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { formatNumber } from "../lib/i18n/format.ts";
import { languageTag } from "../lib/i18n/locales.ts";
import { syntheticBrowserTrace } from "./helpers/synthetic-browser-trace.mjs";

async function assertMobileAssignment(page, locale) {
  const result = await page.locator("#inbox-team").evaluate(team => {
    const form = team.closest("form"), rect = form.getBoundingClientRect(), style = getComputedStyle(form);
    const left = rect.left + parseFloat(style.paddingLeft), right = rect.right - parseFloat(style.paddingRight);
    const controls = [...form.querySelectorAll("label > select")].map(control => {
      const label = control.closest("label").getBoundingClientRect(), bounds = control.getBoundingClientRect();
      return { id: control.id, left: bounds.left, right: bounds.right, top: label.top, bottom: label.bottom };
    });
    return { left, right, controls };
  });
  assert.deepEqual(result.controls.map(control => control.id), ["inbox-team", "inbox-owner", "inbox-state"]);
  for (const [index, control] of result.controls.entries()) {
    assert.ok(Math.abs(control.left - result.left) <= 1 && Math.abs(control.right - result.right) <= 1, `${locale}: ${control.id} must use the full mobile assignment width`);
    if (index) assert.ok(control.top >= result.controls[index - 1].bottom - 1, `${locale}: mobile assignment controls must stack`);
  }
}

const base = process.env.WASALX_STORYBOOK_URL ?? "http://127.0.0.1:6227";
const output = process.env.WASALX_SYNTHETIC_UI_OUTPUT ?? "output/playwright/inbox";
const articleCreatedAt = "2026-10-17T22:30:00.000Z";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.WASALX_VISUAL_BROWSER_PATH ? { executablePath: process.env.WASALX_VISUAL_BROWSER_PATH } : {}), headless: true });
const trace = syntheticBrowserTrace(browser, base, output);
try {
  for (const locale of ["en", "ar"]) {
    const context = await trace.newContext({ locale: locale === "ar" ? "en-US" : "ar-SA", viewport: { width: 1440, height: 1000 } });
    const attachmentName = locale === "ar" ? "إرفاق ملفات" : "Attach files";
    const noAttachments = locale === "ar" ? "لا توجد ملفات مرفقة" : "No files attached";
    const attachFiles = page => page.getByRole("button", { name: attachmentName, exact: true });
    const page = await context.newPage();
    // Enable Playwright's asynchronous chooser interception before navigation.
    page.on("filechooser", () => undefined);
    await page.clock.install();
    const tickets = [
      { id: "42", number: "1042", title: "Delivery update", customer: "Ahmed", team: "Customer support",
        team_id: "2", owner_id: "12", owner: "Maya", updated_at: "2026-10-18T00:00:00.000000Z", closed: false, state: "open", channel: "whatsapp" },
      { id: "43", number: "1043", title: "Invoice question", customer: "Sara", team: "Accounts",
        team_id: "3", owner_id: "12", owner: "Maya", updated_at: "2026-10-18T00:00:00.000000Z", closed: false, state: "open", channel: "email" },
    ];
    const history = new Map(tickets.map(ticket => [ticket.id, [{
      id: "1", body: '<img src=x onerror="window.unsafeArticle=true"> Where is my order?',
      internal: false, author: ticket.customer, sender: "Customer",
      created_at: ticket.id === "42" ? articleCreatedAt : ticket.updated_at,
      attachments: [{ id: "5", filename: "request.txt", size: 28 }],
    }]]));
    const receipts = new Map(), createReceipts = new Map(), uploads = new Map();
    history.get("43").push(
      { id: "2", body: "Sent invoice", internal: false, author: "Maya", sender: "Agent", created_at: tickets[1].updated_at, attachments: [],
        delivery: { state: "SENT", attempts: 1, automatic_attempts_ended: false, notice: false } },
      { id: "3", body: "", internal: true, author: "Zammad System", sender: "System", created_at: tickets[1].updated_at, attachments: [],
        delivery: { state: "UNCONFIRMED", attempts: null, automatic_attempts_ended: true, notice: true } },
      { id: "4", body: "Automated delivery reminder", internal: false, author: "Zammad <system@example.invalid>", sender: "System", created_at: tickets[1].updated_at, attachments: [],
        delivery: { state: "SENT", attempts: 1, automatic_attempts_ended: false, notice: false } },
    );
    const limits = { accepted: null, maximum_file_bytes: 50_000_000, maximum_files: 10, maximum_total_bytes: 50_000_000 };
    const digest = body => createHash("sha256").update(body).digest("hex");
    const articlePage = article => { const points = Array.from(article.body); return { ...article, body: points.slice(0, 50_000).join(""), body_complete: points.length <= 50_000,
      body_sha256: digest(article.body), total_characters: points.length }; };
    let createWrites = 0, createGate, rejectUpdate = false;
    const deliverLateArticles = locale === "ar";
    let sequence = 10, writes = 0, loseReply = false, revoked = false, checkUnavailable = false, paginate = false;
    let releasePage, enteredPage, releaseArticles, enteredArticles, listGate;
    await page.route("**/api/inbox/attachment", route => route.fulfill({
      status: 200, contentType: "application/octet-stream", body: "Synthetic customer attachment",
    }));
    await page.route("**/api/inbox/upload", route => {
      const filename = /filename="([^"]+)"/u.exec(route.request().postData() ?? "")?.[1];
      assert.ok(filename, "expected a staged file");
      const id = String(70 + uploads.size), file = { id, filename, mime_type: "text/plain", size: 12 };
      uploads.set(id, file); return route.fulfill({ status: 200, json: { items: [file] } });
    });
    await page.route("**/api/inbox", async route => {
      const { operation, input } = route.request().postDataJSON();
      const reply = data => route.fulfill({ status: 200, json: data });
      if (revoked) return route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
      if (operation === "CHECK") return checkUnavailable ? route.fulfill({ status: 503, json: {} }) : reply({ allowed: true });
      if (operation === "LIST" && input.before) {
        enteredPage?.(); await new Promise(resolve => { releasePage = resolve; });
        return reply({ items: [{ ...tickets[0], id: "40", number: "1040", title: "Old filter result" }], next_cursor: null });
      }
      if (operation === "LIST" && listGate) await listGate;
      if (operation === "LIST") return reply({ items: tickets.filter(ticket =>
        (!input.ticket_number || ticket.number === input.ticket_number) &&
        (!input.state || (ticket.closed ? "closed" : "open") === input.state) &&
        (!input.query || ticket.title.toLowerCase().includes(input.query.toLowerCase()))), next_cursor: paginate ? "41" : null });
      if (operation === "CREATE_OPTIONS") return reply({ can_create: true, groups: [{ id: "2", name: "Customer support" }, { id: "3", name: "Accounts" }],
        owners: [{ id: "12", name: "Maya" }, { id: "13", name: "Omar" }], states: [{ id: "2", name: "open", closed: false }],
        customers: input.query?.length >= 2 ? [{ id: "20", name: "Synthetic customer", email: "customer@example.invalid" }] : [],
        channels: { note: true, email: true }, upload_constraints: limits });
      if (operation === "CREATE_RECEIPT") {
        const known = createReceipts.get(input.operation_id);
        if (known) return reply(known);
        if (input.action === "LOOKUP") return reply({ state: "UNKNOWN" });
        const result = { state: "NOT_APPLIED", terminal: true, operation_id: input.operation_id }; createReceipts.set(input.operation_id, result); return reply(result);
      }
      if (operation === "CREATE_TICKET") {
        if (createReceipts.has(input.operation_id)) return reply(createReceipts.get(input.operation_id));
        const heldCreate = createGate;
        createGate = undefined;
        if (heldCreate) await heldCreate;
        const ticket = { ...tickets[0], id: String(44 + createWrites), number: String(1044 + createWrites), title: input.title, team_id: input.group_id,
          team: input.group_id === "3" ? "Accounts" : "Customer support", channel: input.internal ? "other" : "email" };
        tickets.push(ticket); createWrites++;
        history.set(ticket.id, [{ id: "1", body: input.body, internal: input.internal, author: "Maya", sender: "Agent", created_at: ticket.updated_at,
          attachments: (input.attachment_ids ?? []).map(id => uploads.get(id)) }]);
        const result = { state: "APPLIED", operation_id: input.operation_id, ticket_id: ticket.id, ticket_number: ticket.number, article_id: "1" };
        createReceipts.set(input.operation_id, result);
        if (heldCreate) return route.abort("failed");
        return reply(result);
      }
      if (operation === "REMOVE_UPLOAD") { uploads.delete(input.upload_store_id); return reply({ removed: true }); }
      const ticket = tickets.find(item => item.id === input.ticket_id);
      if (!ticket) return route.fulfill({ status: 404, json: {} });
      if (operation === "SHOW") return reply({ ...ticket, can_update: true, can_reply: true, owner_team_id: input.group_id ?? ticket.team_id, upload_constraints: limits,
        recipient_delivery: ticket.channel === "email" ? { state: "RECENT_FAILURE", reason: "INVALID_ADDRESS" } : null,
        teams: [{ id: "2", name: "Customer support" }, { id: "3", name: "Accounts" }],
        owners: [{ id: "12", name: "Maya" }, { id: "13", name: "Omar" }],
        states: [{ id: "2", name: "open", closed: false }, { id: "4", name: "closed", closed: true }] });
      if (operation === "ARTICLES") {
        if (ticket.id === "43" && enteredArticles) {
          const gate = Promise.withResolvers();
          releaseArticles = gate.resolve;
          enteredArticles(route.request());
          enteredArticles = undefined;
          await gate.promise;
          if (!deliverLateArticles) return route.abort("aborted");
        }
        return reply({ items: [...history.get(ticket.id)].reverse().map(articlePage), next_cursor: null });
      }
      if (operation === "ARTICLE_CONTENT") {
        const article = history.get(ticket.id).find(item => item.id === input.article_id), points = Array.from(article.body);
        if (input.expected_sha256 !== digest(article.body)) return route.fulfill({ status: 409, json: {} });
        const end = Math.min(input.offset + input.limit, points.length);
        return reply({ article_id: article.id, body: points.slice(input.offset, end).join(""), body_sha256: digest(article.body), total_characters: points.length, next_offset: end < points.length ? end : null });
      }
      if (operation === "PREVIEW") return reply({ draft_sha256: digest(JSON.stringify(input)), ticket_updated_at: ticket.updated_at,
        channel: input.internal ? "internal_note" : ticket.channel, text: input.body, recipient: input.internal ? null : "Synthetic customer", team: ticket.team,
        quoted: false, can_send: true, handover_required: false, routing_notice: input.internal ? "INTERNAL_ONLY" : ticket.channel === "email" ? "EMAIL" : "WHATSAPP" });
      if (operation === "RECEIPT") {
        const known = receipts.get(input.operation_id); if (known) return reply(known);
        if (input.action === "LOOKUP") return reply({ state: "UNKNOWN" });
        const result = { state: "NOT_APPLIED", terminal: true, operation_id: input.operation_id, ticket_id: ticket.id }; receipts.set(input.operation_id, result); return reply(result);
      }
      if (rejectUpdate && operation === "UPDATE") { rejectUpdate = false; return route.fulfill({ status: 409, json: {} }); }
      if (receipts.has(input.operation_id)) return reply(receipts.get(input.operation_id));
      writes++;
      if (operation === "REPLY") history.get(ticket.id).push({ id: String(++sequence), body: input.body,
        author: "Maya", internal: input.internal, sender: "Agent", created_at: ticket.updated_at, attachments: (input.attachment_ids ?? []).map(id => uploads.get(id)) });
      if (operation === "UPDATE") {
        if (input.group_id) { ticket.team_id = input.group_id; ticket.team = input.group_id === "3" ? "Accounts" : "Customer support"; }
        if (input.owner_id) { ticket.owner_id = input.owner_id; ticket.owner = input.owner_id === "13" ? "Omar" : "Maya"; }
        if (input.state_id) { ticket.closed = input.state_id === "4"; ticket.state = ticket.closed ? "closed" : "open"; }
      }
      const result = { state: "APPLIED", ticket_id: ticket.id, operation_id: input.operation_id };
      receipts.set(input.operation_id, result);
      if (loseReply && operation === "REPLY") { loseReply = false; return route.abort("failed"); }
      return reply(result);
    });
    await page.goto(`${base}/iframe.html?id=product-inbox--${locale === "ar" ? "arabic" : "english"}`, { waitUntil: "networkidle" });
    const ticket42 = page.getByRole("button").filter({ hasText: "#1042" });
    const ticket43 = page.getByRole("button").filter({ hasText: "#1043" });
    await ticket42.click();
    await expect(page.locator("#inbox-message")).toBeVisible();
    await expect(page.locator("h2", { hasText: "Delivery update" })).toBeVisible();
    const articleTime = page.locator('[data-article-id="1"] time');
    const expectedArticleTime = await page.evaluate(
      ({ tag, instant }) => new Intl.DateTimeFormat(tag, {
        dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Riyadh",
      }).format(new Date(instant)),
      { tag: languageTag(locale), instant: articleCreatedAt },
    );
    await expect(articleTime).toBeVisible();
    await expect(articleTime).toHaveText(expectedArticleTime);
    await expect(articleTime).toHaveAttribute("datetime", articleCreatedAt);
    assert.equal(await page.evaluate(() => window.unsafeArticle), undefined);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: locale === "ar" ? "تنزيل request.txt" : "Download request.txt" }).click();
    assert.equal((await downloadEvent).suggestedFilename(), "request.txt");
    await page.locator("#inbox-message").fill("Preserve this reply");
    await page.locator("#inbox-owner").selectOption("13");
    await ticket43.click();
    await expect(page.locator('[data-article-id="2"] [data-email-delivery="SENT"]')).toHaveText(locale === "ar" ? "أُرسل إلى خادم البريد. لم يُؤكَّد وصوله إلى المستلم." : "Sent to the mail server. Delivery to the recipient is not confirmed.");
    await expect(page.locator('[data-email-delivery="UNCONFIRMED"]')).toContainText(locale === "ar" ? "انتهت محاولات التسليم التلقائية" : "Automatic delivery attempts have ended");
    await expect(page.locator('[data-recipient-delivery="RECENT_FAILURE"]')).toContainText(locale === "ar" ? "غير صالح" : "invalid");
    for (const id of ["3", "4"]) await expect(page.locator(`[data-article-id="${id}"] > div > b`)).toHaveText("WasalX");
    await expect(page.locator('[data-article-id="4"] > div > span')).toHaveText(locale === "ar" ? "رسالة النظام" : "System message");
    await expect(page.locator('[data-article-id="3"] > div > span')).toHaveText(locale === "ar" ? "ملاحظة داخلية" : "Internal note");
    await expect(page.locator('[data-article-id="4"]')).toContainText("Automated delivery reminder");
    await page.locator("#inbox-message").fill("Separate email draft");
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    await ticket42.click();
    await page.clock.runFor(16);
    await expect(page.locator("#inbox-message")).toHaveValue("Preserve this reply");
    await expect(page.locator("#inbox-owner")).toHaveValue("13");
    await page.locator("#inbox-kind").selectOption("note");
    await page.locator("#inbox-message").fill("Team-only note");
    await page.locator("#inbox-kind").selectOption("reply");
    await expect(page.locator("#inbox-message")).toHaveValue("Preserve this reply");
    checkUnavailable = true;
    const unavailable = page.waitForResponse(response => response.request().postDataJSON()?.operation === "CHECK" && response.status() === 503);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.runFor(16); await unavailable;
    await expect(page.locator("#inbox-message")).toHaveCount(0);
    const reload = page.getByRole("button", { name: locale === "ar" ? "إعادة تحميل المحادثات" : "Reload conversations", exact: true });
    await expect(reload).toBeVisible();
    let releaseList;
    listGate = new Promise(resolve => { releaseList = resolve; });
    const listStarted = page.waitForRequest(request => request.url().endsWith("/api/inbox") && request.postDataJSON().operation === "LIST");
    const listFinished = page.waitForResponse(response => response.url().endsWith("/api/inbox") && response.request().postDataJSON().operation === "LIST");
    await page.clock.runFor(300);
    await listStarted;
    await expect(reload).toBeVisible();
    listGate = null; releaseList();
    await (await listFinished).finished();
    await expect(reload).toBeVisible();
    checkUnavailable = false;
    await page.clock.resume();
    await reload.click();
    await expect(page.locator("#inbox-message")).toHaveValue("Preserve this reply");
    await expect(page.locator("#inbox-owner")).toHaveValue("13");
    await page.locator("#inbox-message").fill("Assignment-preserving reply");
    await page.getByRole("button", { name: locale === "ar" ? "معاينة الرد" : "Preview reply", exact: true }).click();
    await page.locator('form').last().locator(".wx-button-primary").click();
    await expect(page.locator("#inbox-message")).toHaveValue("");
    await expect(page.locator("#inbox-owner")).toHaveValue("13");
    await page.locator("#inbox-message").fill("Preserve this reply");
    loseReply = true;
    await page.getByRole("button", { name: locale === "ar" ? "معاينة الرد" : "Preview reply", exact: true }).click();
    await page.locator('form').last().locator(".wx-button-primary").click();
    await expect(page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission" })).toBeVisible();
    assert.equal(writes, 2);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission" }).click();
    await expect(page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission" })).toHaveCount(0);
    assert.equal(writes, 2);
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await expect(page.getByText("Preserve this reply", { exact: true })).toBeVisible();
    history.get("42")[0].body = "Please check the delivery for order 1042.";
    await page.getByRole("button").filter({ hasText: "#1043" }).click();
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await expect(page.getByText("Please check the delivery for order 1042.", { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}/inbox-${locale}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/inbox-${locale}-mobile.png`, fullPage: true });
    await assertMobileAssignment(page, locale);
    const accessibility = await new AxeBuilder({ page }).include("section").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(accessibility.violations.map(item => item.id), [], `${locale}: automated accessibility violations`);
    await page.getByRole("button", { name: locale === "ar" ? "العودة إلى المحادثات" : "Back to conversations" }).click();
    await expect(page.locator("#inbox-search")).toBeFocused();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `${locale}: horizontal overflow`);
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await page.goto(`${base}/iframe.html?id=product-inbox--${locale === "ar" ? "arabic" : "english"}&globals=theme:dark`, { waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await expect(page.locator("#inbox-message")).toBeVisible();
    await page.screenshot({ path: `${output}/inbox-${locale}-dark-mobile.png`, fullPage: true });
    await assertMobileAssignment(page, locale);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${output}/inbox-${locale}-dark-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 720, height: 500 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "200% equivalent viewport overflows");
    await page.locator("#inbox-kind").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#inbox-message")).toBeFocused();
    for (const malformed of ["{", JSON.stringify({ ticket_id: [42], operation_id: crypto.randomUUID() }),
      JSON.stringify({ ticket_id: "42", operation_id: "-".repeat(36) })]) {
      await page.evaluate(raw => sessionStorage.setItem("wasalx:inbox-operation:storybook:synthetic-operator", raw), malformed);
      await page.reload({ waitUntil: "networkidle" });
      await expect(page.getByRole("button").filter({ hasText: "#1042" })).toBeVisible();
      assert.equal(await page.evaluate(() => sessionStorage.getItem("wasalx:inbox-operation:storybook:synthetic-operator")), malformed);
      await page.getByRole("button").filter({ hasText: "#1042" }).click();
      await page.locator("#inbox-message").fill("Must not send with corrupt recovery");
      await expect(page.locator('form').last().locator(".wx-button-primary")).toBeDisabled();
      await page.evaluate(() => sessionStorage.removeItem("wasalx:inbox-operation:storybook:synthetic-operator"));
      await page.reload({ waitUntil: "networkidle" });
    }
    // Bounded completeness extensions; existing outage/pagination/revocation checks remain below.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await expect(page.locator("#inbox-message")).toBeVisible();
    await page.locator("#inbox-message").fill("Never dispatch when receipt storage fails");
    await page.getByRole("button", { name: locale === "ar" ? "معاينة الرد" : "Preview reply", exact: true }).click();
    const beforeStorageFailure = writes;
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreTicketStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) { if (key.startsWith("wasalx:inbox-operation:")) throw new DOMException("Synthetic quota", "QuotaExceededError"); return original.call(this, key, value); };
    });
    await page.locator('form').last().locator(".wx-button-primary").click();
    await expect(page.locator('form').last().locator(".wx-button-primary")).toBeDisabled();
    assert.equal(writes, beforeStorageFailure);
    await expect(page.locator("#inbox-message")).toHaveValue("Never dispatch when receipt storage fails");
    await page.evaluate(() => window.restoreTicketStorage()); await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await page.locator("#inbox-team").selectOption("3");
    await expect(page.locator("#inbox-owner")).toHaveValue("1");
    await page.locator("#inbox-owner").selectOption("13");
    rejectUpdate = true;
    await page.getByRole("button", { name: locale === "ar" ? "حفظ التغييرات" : "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission", exact: true })).toBeVisible();
    await page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission", exact: true }).click();
    await expect(page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission", exact: true })).toBeVisible();
    await page.getByRole("button", { name: locale === "ar" ? "التحقق والإيقاف إن لم يبدأ الإجراء" : "Check and stop if it has not started", exact: true }).click();
    await expect(page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: locale === "ar" ? "حفظ التغييرات" : "Save changes", exact: true }).click();
    await expect(page.locator("#inbox-team")).toHaveValue("3");
    await expect(page.locator("#inbox-owner")).toHaveValue("13");
    await expect(page.locator("#inbox-files")).toBeHidden();
    await expect(attachFiles(page)).toBeEnabled();
    await expect(attachFiles(page)).toHaveAccessibleDescription(noAttachments);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), attachFiles(page).press("Enter")]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles([
      { name: "outgoing.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic UI") },
      { name: "remove.txt", mimeType: "text/plain", buffer: Buffer.from("Remove this") },
    ]);
    const keepFile = page.getByRole("button", { name: locale === "ar" ? "إزالة outgoing.txt" : "Remove outgoing.txt" });
    const removeFile = page.getByRole("button", { name: locale === "ar" ? "إزالة remove.txt" : "Remove remove.txt" });
    await expect(keepFile).toBeVisible();
    await expect(attachFiles(page)).not.toHaveAccessibleDescription(noAttachments);
    await removeFile.click();
    await expect(removeFile).toHaveCount(0);
    await expect(keepFile).toBeVisible();
    await page.locator("#inbox-message").fill("");
    await expect(page.locator('form').last().locator(".wx-button-primary")).toBeDisabled();
    await page.getByRole("button", { name: locale === "ar" ? "معاينة الرد" : "Preview reply", exact: true }).click();
    await expect(page.locator('form').last().locator(".wx-button-primary")).toBeEnabled();
    await page.locator("#inbox-message").fill("Snapshot changed");
    await expect(page.locator('form').last().locator(".wx-button-primary")).toBeDisabled();
    await page.locator("#inbox-message").fill("");
    await page.getByRole("button", { name: locale === "ar" ? "معاينة الرد" : "Preview reply", exact: true }).click();
    await page.locator('form').last().locator(".wx-button-primary").click();
    await expect(attachFiles(page)).toBeVisible();
    await expect(attachFiles(page)).toHaveAccessibleDescription(noAttachments);
    await expect(page.getByRole("button", { name: locale === "ar" ? "إزالة outgoing.txt" : "Remove outgoing.txt" })).toHaveCount(0);
    // Keep the surrogate pair at the preview boundary without shaping one enormous bidi word.
    const longBody = `${"Synthetic article body. ".repeat(2_174).slice(0, 49_997)} أ😀أ😀`;
    const longArticle = { ...history.get("42")[0], id: "99", body: longBody, attachments: [] };
    const trailingBody = "Synthetic article after the long message";
    history.get("42").push(longArticle, { ...longArticle, id: "100", body: trailingBody });
    await ticket43.click();
    await expect(page.getByRole("heading", { name: "Invoice question", exact: true })).toBeVisible();
    await ticket42.click();
    await expect(page.getByRole("heading", { name: "Delivery update", exact: true })).toBeVisible();
    await expect(page.locator('[data-article-id="100"]')).toContainText(trailingBody);
    const fullArticle = page.locator('[data-article-id="99"] .wx-ticket-full-article');
    const previewBody = Array.from(longBody).slice(0, 50_000).join("");
    await expect(fullArticle.locator('p[dir="auto"]')).toHaveText(previewBody);
    const format = { format: value => formatNumber(value, locale) };
    await expect(fullArticle.locator("p").nth(1)).toHaveText(locale === "ar"
      ? `يُعرض ${format.format(50_000)} من أصل ${format.format(50_002)} حرفًا.`
      : `Showing ${format.format(50_000)} of ${format.format(50_002)} characters.`);
    assert.equal(Array.from(previewBody).at(-1), "😀");
    await fullArticle
      .getByRole("button", { name: locale === "ar" ? "قراءة بقية الرسالة" : "Read more of this message" })
      .click();
    await expect(fullArticle.locator('p[dir="auto"]')).toHaveText(longBody);
    await expect(fullArticle.getByRole("button")).toHaveCount(0);
    await expect(fullArticle.locator("p")).toHaveCount(1);
    await page.getByRole("button", { name: locale === "ar" ? "تذكرة جديدة" : "New ticket", exact: true }).click();
    await page.locator("#wx-ticket-create-team").selectOption("2");
    await page.locator("#wx-ticket-customer-query").fill("Synthetic");
    await expect(page.locator("#wx-ticket-customer option[value='20']")).toHaveCount(1);
    await page.locator("#wx-ticket-customer").selectOption("20");
    const createTitle = "Synthetic attachment-only email";
    await page.locator("#wx-ticket-title").fill(createTitle);
    await page.locator("#wx-ticket-mode").selectOption("email");
    await expect(attachFiles(page.getByRole("dialog"))).toHaveAccessibleDescription(noAttachments);
    await page.locator("#inbox-create-files").setInputFiles({ name: "outgoing.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic UI") });
    await expect(page.locator("#wx-ticket-create-body")).not.toHaveAttribute("required", "");
    const create = Promise.withResolvers();
    createGate = create.promise;
    const lostCreate = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.url().endsWith("/api/inbox") &&
        request.postDataJSON()?.operation === "CREATE_TICKET" &&
        request.postDataJSON().input.title === createTitle,
    });
    await page.getByRole("button", { name: locale === "ar" ? "إنشاء تذكرة وإرسال بريد للعميل" : "Create ticket and email customer", exact: true }).click();
    const checkSubmission = page.getByRole("dialog").getByRole("button", {
      name: locale === "ar" ? "التحقق من الإرسال" : "Check submission",
      exact: true,
    });
    // Recovery controls can render while the write is still held.
    await expect(checkSubmission).toBeDisabled();
    assert.equal(createWrites, 0);
    create.resolve();
    const failedCreate = await lostCreate;
    assert.equal(failedCreate.failure()?.errorText, "net::ERR_FAILED");
    assert.equal(createReceipts.get(failedCreate.postDataJSON().input.operation_id)?.state, "APPLIED");
    await expect(checkSubmission).toBeEnabled();
    await expect(page.getByText(locale === "ar" ? "لم تتأكد النتيجة بعد. تحقق من الإجراء الحالي قبل إنشاء تذكرة أخرى." : "The result has not been confirmed. Check the existing submission before creating another ticket.").first()).toBeVisible();
    assert.equal(createWrites, 1);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await page.locator("#inbox-message").fill("Independent draft during pending create");
    await page.getByRole("button", { name: locale === "ar" ? "التحقق من الإرسال" : "Check submission", exact: true }).click();
    assert.equal(createWrites, 1);
    await expect(page.getByRole("button").filter({ hasText: "#1044" })).toBeVisible();
    await page.getByRole("button").filter({ hasText: "#1042" }).click();
    await expect(page.locator("#inbox-message")).toHaveValue("Independent draft during pending create");
    await page.locator("#inbox-message").fill("");
    await page.getByRole("button", { name: locale === "ar" ? "تذكرة جديدة" : "New ticket", exact: true }).click();
    await page.locator("#wx-ticket-create-team").selectOption("2");
    await page.locator("#wx-ticket-customer-mode").selectOption("new");
    await page.locator("#wx-ticket-new-email").fill("first-contact@example.invalid");
    await page.locator("#wx-ticket-new-name").fill("Synthetic first contact");
    await page.locator("#wx-ticket-title").fill("First contact request");
    await page.locator("#wx-ticket-create-body").fill("Synthetic internal request");
    const firstContactRequest = page.waitForRequest(request => request.url().endsWith("/api/inbox") && request.postDataJSON()?.operation === "CREATE_TICKET");
    await page.getByRole("button", { name: locale === "ar" ? "إنشاء تذكرة بملاحظة" : "Create ticket with note", exact: true }).click();
    const firstContactInput = (await firstContactRequest).postDataJSON().input;
    assert.deepEqual(firstContactInput.customer, { email: "first-contact@example.invalid", name: "Synthetic first contact" });
    assert.equal(firstContactInput.customer_id, undefined);
    await expect(page.getByRole("button").filter({ hasText: "#1045" })).toBeVisible();
    assert.equal(createWrites, 2);
    paginate = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const more = page.getByRole("button", { name: locale === "ar" ? "تحميل محادثات أخرى" : "Load more conversations" });
    await expect(more).toBeVisible();
    const pendingPage = new Promise(resolve => { enteredPage = resolve; });
    await more.click(); await pendingPage;
    await page.locator("#inbox-search").fill("Invoice");
    await expect(page.getByRole("button").filter({ hasText: "#1043" })).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "#1042" })).toHaveCount(0);
    const oldPage = page.waitForResponse(response => response.request().postDataJSON()?.input?.before === "41");
    releasePage(); await oldPage;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByRole("button").filter({ hasText: "#1040" })).toHaveCount(0);
    paginate = false;
    await page.locator("#inbox-search").fill("");
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (deliverLateArticles) {
      // Keep the transport alive once so the stale body reaches the app after denial.
      await page.evaluate(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = (resource, init) => {
          if (resource === "/api/inbox") {
            const { operation, input } = JSON.parse(init.body);
            if (operation === "ARTICLES" && input.ticket_id === "43") {
              window.fetch = originalFetch;
              return originalFetch(resource, { ...init, signal: undefined });
            }
          }
          return originalFetch(resource, init);
        };
      });
    }
    const pendingArticles = new Promise((resolve) => {
      enteredArticles = resolve;
    });
    await ticket43.click();
    const heldArticles = await pendingArticles;
    const isHeldArticles = (request) => request === heldArticles;
    const settledArticles = Promise.race([
      page.waitForEvent("requestfailed", { predicate: isHeldArticles }),
      page.waitForEvent("requestfinished", { predicate: isHeldArticles }),
    ]);
    const denial = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/inbox") &&
        response.request().postDataJSON()?.operation === "CHECK" &&
        response.status() === 403,
    );
    revoked = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await denial;
    await expect(
      page.getByRole("button", { name: locale === "ar" ? "تذكرة جديدة" : "New ticket", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#inbox-message")).toHaveCount(0);
    await expect(page.getByText("Preserve this reply", { exact: true })).toHaveCount(0);
    releaseArticles();
    const terminalArticles = await settledArticles;
    if (deliverLateArticles) {
      assert.equal(terminalArticles.failure(), null);
      assert.equal((await terminalArticles.response())?.status(), 200);
    } else {
      assert.equal(terminalArticles.failure()?.errorText, "net::ERR_ABORTED");
    }
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(page.locator("#inbox-message")).toHaveCount(0);
    await expect(page.locator("h2", { hasText: "Invoice question" })).toHaveCount(0);
    await expect(page.locator("[data-article-id]")).toHaveCount(0);
    console.log(`${locale}: held ARTICLES ${deliverLateArticles ? "answered late" : "aborted"} after access denial`);
    console.log(`${locale}: drafts survive outage/reply, stale pagination and post-denial detail fenced, corrupt recovery rejected, unknown result/reload reconciled, mobile/keyboard/RTL passed; writes=${writes}`);
    await trace.closeContext(context);
  }
} catch (error) {
  await trace.retainFailure();
  throw error;
} finally { await browser.close(); }
