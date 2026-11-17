import { expect, type Page, type TestInfo } from "@playwright/test";
import { englishAutomationMessages } from "../../lib/i18n/messages/en/automation.ts";
import { arabicAutomationMessages } from "../../lib/i18n/messages/ar/automation.ts";
import { parseTicketEventFlow } from "../../packages/core/src/ticket-event-flow.ts";

/** Local portal fixture only; every workflow/configuration mutation is intercepted. */
export async function ticketEventWorkflowJourney(page: Page, testInfo: TestInfo, locale: "en" | "ar") {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicAutomationMessages : englishAutomationMessages;
  const t = (key: string) => messages[`ticketEvent.${key}`]!;
  const versions: Record<string, unknown>[] = [];
  const bindings: Record<string, unknown>[] = [];
  const writes: { path: string; body: Record<string, unknown>; key: string | undefined }[] = [];
  const groupId = "f0000000-0000-4000-8000-000000000001";
  const familyId = "f0000000-0000-4000-8000-000000000002";
  const memberId = "f0000000-0000-4000-8000-000000000003";
  await page.route("**/api/bot-flows**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/bot-flows/catalog") {
      const response = await route.fetch();
      const data = await response.json() as { items: Record<string, unknown>[]; next_cursor: string | null };
      await route.fulfill({ response, json: { ...data, items: [...versions, ...data.items] } }); return;
    }
    if (request.method() === "GET" && pathname === "/api/bot-flows/ticket-events") {
      await route.fulfill({ json: { bindings, groups: [{ id: groupId, display_name: "Customer group", provider: "WAHA" }], members: [{ id: memberId, display_name: "Maya", role: "tenant_owner" }] } }); return;
    }
    const version = versions.find(row => pathname === `/api/bot-flows/${String(row.flow_version_id)}`);
    if (request.method() === "GET" && version) {
      await route.fulfill({ json: { ...version, active_flow_version_id: versions.find(row => row.state === "ACTIVE")?.flow_version_id ?? null } }); return;
    }
    if (request.method() !== "POST") { await route.continue(); return; }
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push({ path: pathname, body, key: request.headers()["idempotency-key"] });
    expect(request.headers()["idempotency-key"]).toBeTruthy();
    if (pathname === "/api/bot-flows" || pathname.endsWith("/clone")) {
      const definition = parseTicketEventFlow(body);
      const id = `f0000000-0000-4000-8000-${String(versions.length + 10).padStart(12, "0")}`;
      versions.unshift({ flow_version_id: id, family_id: familyId, name: definition.name, version: versions.length + 1, state: "DRAFT", revision: 1, definition, kind: "TICKET_EVENT", event: definition.event, assignment_count: 0 });
      await route.fulfill({ status: 201, json: { id, familyId, version: versions.length, revision: 1 } }); return;
    }
    if (pathname.endsWith("/activate")) {
      const target = versions.find(row => pathname === `/api/bot-flows/${String(row.flow_version_id)}/activate`)!;
      const previous = versions.find(row => row.state === "ACTIVE");
      expect(body.expectedRevision).toBe(target.revision);
      expect(body.expectedActiveFlowVersionId).toBe(previous?.flow_version_id ?? null);
      if (previous) previous.state = "RETIRED";
      target.state = "ACTIVE"; target.revision = Number(target.revision) + 1;
      await route.fulfill({ json: { flowVersionId: target.flow_version_id, retiredFlowVersionId: previous?.flow_version_id ?? null, revision: target.revision } }); return;
    }
    if (pathname === "/api/bot-flows/ticket-events") {
      const index = bindings.findIndex(row => row.event === body.event && row.whatsapp_group_id === body.groupId);
      const previous = bindings[index];
      expect(body.expectedRevision).toBe(previous?.revision ?? 0);
      if (body.mode === "CUSTOM") expect(versions.some(row => row.flow_version_id === body.flowVersionId && row.state !== "DRAFT")).toBe(true);
      else expect(body.flowVersionId).toBeNull();
      const row = { id: previous?.id ?? `binding-${bindings.length}`, event: body.event, whatsapp_group_id: body.groupId, mode: body.mode, flow_version_id: body.flowVersionId, revision: Number(previous?.revision ?? 0) + 1 };
      if (index < 0) bindings.push(row); else bindings[index] = row;
      await route.fulfill({ json: row }); return;
    }
    throw new Error(`Unexpected mutation in ticket workflow journey: ${pathname}`);
  });
  await page.goto("/app?view=automation");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const flowsTab = page.getByRole("tab", { name: messages["bot.tabs.flows"], exact: true });
  const assignmentsTab = page.getByRole("tab", { name: messages["bot.tabs.assignments"], exact: true });
  const ticketWorkflowsTab = page.getByRole("tab", { name: t("workspace.tab"), exact: true });
  await flowsTab.focus();
  await flowsTab.press("End");
  await expect(assignmentsTab).toBeFocused();
  await expect(assignmentsTab).toHaveAttribute("aria-selected", "true");
  await assignmentsTab.press("Home");
  await expect(flowsTab).toBeFocused();
  await expect(flowsTab).toHaveAttribute("aria-selected", "true");
  await flowsTab.press("ArrowRight");
  await expect(ticketWorkflowsTab).toBeFocused();
  await expect(ticketWorkflowsTab).toHaveAttribute("aria-selected", "true");
  const panel = page.locator("#bot-panel-ticket-events");
  const initialBinding = panel.getByRole("region", { name: t("workspace.bindings"), exact: true });
  await expect(initialBinding.getByRole("combobox", { name: t("workspace.mode"), exact: true })).toHaveValue("LEGACY");
  await expect(initialBinding.getByText(t("workspace.effectiveLegacy"), { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: t("workspace.create"), exact: true }).click();
  const draft = panel.locator("form.panel.bot-flow-editor");
  await expect(draft.locator('option[value="REFERENCE_MESSAGES"]')).toHaveCount(0);
  await draft.getByRole("textbox", { name: t("name"), exact: true }).fill("Ticket reference workflow");
  await draft.getByRole("textbox", { name: t("text"), exact: true }).fill("Reference: ");
  await draft.getByRole("combobox", { name: t("insertVariable"), exact: true }).selectOption("case.reference");
  await draft.getByRole("button", { name: t("insert"), exact: true }).click();
  await expect(draft.getByRole("textbox", { name: t("text"), exact: true })).toHaveValue("Reference: {{case.reference}}");
  await draft.getByRole("combobox", { name: t("quote"), exact: false }).selectOption("CURRENT");
  await draft.getByRole("button", { name: t("preview.run"), exact: true }).click();
  await expect(draft.getByText("Reference: REF-50001", { exact: true })).toBeVisible();
  await draft.getByRole("checkbox", { name: t("preview.current"), exact: true }).uncheck();
  await expect(draft.getByText(t("preview.blocked"), { exact: true })).toBeVisible();
  await draft.getByRole("checkbox", { name: t("preview.current"), exact: true }).check();
  await draft.getByRole("combobox", { name: t("stepType"), exact: true }).selectOption("condition");
  await draft.getByRole("button", { name: t("addStep"), exact: true }).click();
  await draft.getByRole("combobox", { name: t("conditionVariable"), exact: true }).selectOption("message.matches_reference");
  await expect(draft.getByRole("combobox", { name: t("value"), exact: true })).toHaveValue("false");
  await draft.getByRole("combobox", { name: t("conditionVariable"), exact: true }).selectOption("case.state");
  await draft.getByRole("combobox", { name: t("onFalse"), exact: true }).selectOption("finish");
  await draft.getByRole("button", { name: t("preview.run"), exact: true }).click();
  await expect(draft.getByText("Reference: REF-50001", { exact: true })).toBeVisible();
  await draft.getByText(t("preview.variables"), { exact: true }).click();
  const sampleState = draft.getByRole("group", { name: t("variable.case.state"), exact: true }).getByRole("combobox", { name: t("preview.value"), exact: true });
  await sampleState.selectOption("RESOLVED");
  await expect(draft.getByText(t("preview.noEffects"), { exact: true })).toBeVisible();
  await sampleState.selectOption("OPEN");
  await draft.getByRole("button", { name: t("workspace.save"), exact: true }).click();
  await expect(draft).toHaveCount(0);
  await panel.getByRole("button", { name: t("workspace.publish"), exact: true }).click();
  await expect(panel.getByRole("heading", { name: t("workspace.publishTitle"), exact: true })).toBeVisible();
  await panel.getByRole("button", { name: t("workspace.publish"), exact: true }).last().click();
  await expect(panel.getByText(t("workspace.published"), { exact: true })).toBeVisible();
  const binding = panel.getByRole("region", { name: t("workspace.bindings"), exact: true });
  await binding.getByRole("combobox", { name: t("workspace.mode"), exact: true }).selectOption("CUSTOM");
  await binding.getByRole("combobox", { name: t("workspace.publishedVersion"), exact: true }).selectOption(String(versions[0]!.flow_version_id));
  await binding.getByRole("button", { name: t("workspace.saveBinding"), exact: true }).click();
  await expect(binding.getByRole("button", { name: t("workspace.saveBinding"), exact: true })).toBeDisabled();
  await binding.getByRole("combobox", { name: t("workspace.scope"), exact: true }).selectOption(groupId);
  await expect(binding.getByRole("combobox", { name: t("workspace.mode"), exact: true })).toHaveValue("INHERIT");
  await binding.getByRole("combobox", { name: t("workspace.mode"), exact: true }).selectOption("OFF");
  await binding.getByRole("button", { name: t("workspace.saveBinding"), exact: true }).click();
  await expect(binding.getByRole("button", { name: t("workspace.saveBinding"), exact: true })).toBeDisabled();
  await binding.getByRole("combobox", { name: t("workspace.mode"), exact: true }).selectOption("INHERIT");
  await binding.getByRole("button", { name: t("workspace.saveBinding"), exact: true }).click();
  await expect(binding.getByRole("button", { name: t("workspace.saveBinding"), exact: true })).toBeDisabled();
  // Saving a clone preserves the family; publishing does not rebind the existing default.
  await panel.getByRole("button", { name: t("workspace.edit"), exact: true }).click();
  await draft.getByRole("textbox", { name: t("name"), exact: true }).fill("Ticket reference workflow updated");
  await draft.getByRole("button", { name: t("workspace.save"), exact: true }).click();
  await expect(draft).toHaveCount(0);
  await panel.getByRole("button", { name: t("workspace.publish"), exact: true }).click();
  await panel.getByRole("button", { name: t("workspace.publish"), exact: true }).last().click();
  await expect(panel.getByText(t("workspace.published"), { exact: true })).toBeVisible();
  expect(bindings.find(row => row.whatsapp_group_id === null)?.flow_version_id).toBe(versions[1]!.flow_version_id);
  expect(writes.map(write => write.path.endsWith("/activate") ? "publish" : write.path.endsWith("/clone") ? "clone" : write.path.endsWith("/ticket-events") ? "bind" : "create")).toEqual(["create", "publish", "bind", "bind", "bind", "clone", "publish"]);
  await page.locator("#bot-tab-flows").click();
  await expect(page.locator("#bot-panel-flows .bot-version-list")).not.toContainText("Ticket reference workflow");
  await page.getByRole("tab", { name: t("workspace.tab"), exact: true }).click();
  // This remains a local UI fixture: one configured reaction expands only against real case history at runtime.
  const beforeClosureWrites = writes.length;
  await panel.getByRole("combobox", { name: t("starter"), exact: true }).first().selectOption("ticket_closed");
  await panel.getByRole("button", { name: t("workspace.create"), exact: true }).click();
  const closureName = locale === "ar" ? "تفاعلات إغلاق كل رسائل المرجع" : "Close all reference messages";
  await draft.getByRole("textbox", { name: t("name"), exact: true }).fill(closureName);
  // All-reference targeting belongs to closure reactions, never the accompanying text message.
  await expect(draft.locator('option[value="REFERENCE_MESSAGES"]')).toHaveCount(0);
  await draft.getByRole("combobox", { name: t("quote"), exact: false }).selectOption("NONE");
  await draft.getByRole("combobox", { name: t("stepType"), exact: true }).selectOption("reaction");
  await draft.getByRole("button", { name: t("addStep"), exact: true }).click();
  const reactionEmojiName = `${t("emoji")} ${t("reactionHelp")}`;
  const reaction = draft.locator("fieldset.bot-node-card").filter({ has: page.getByRole("textbox", { name: reactionEmojiName, exact: true }) });
  await reaction.getByRole("textbox", { name: reactionEmojiName, exact: true }).fill("✅");
  const referenceTarget = reaction.getByRole("combobox", { name: t("quote"), exact: false });
  await referenceTarget.selectOption("REFERENCE_MESSAGES");
  await expect(referenceTarget.locator("option:checked")).toHaveText(t("quote.REFERENCE_MESSAGES"));
  await expect(reaction.getByText(t("referenceMessagesHelp"), { exact: true })).toBeVisible();
  const previewSummary = t("preview.summary").replace("{count}", "2").replace("{steps}", "3").replace("{skipped}", "0");
  await draft.getByRole("checkbox", { name: t("preview.original"), exact: true }).uncheck();
  await draft.getByRole("checkbox", { name: t("preview.latest"), exact: true }).uncheck();
  await draft.getByRole("button", { name: t("preview.run"), exact: true }).click();
  await expect(draft.getByRole("status")).toContainText(previewSummary);
  await expect(draft.locator(".ticket-event-preview-results > li")).toHaveCount(2);
  await expect(draft.getByText(t("preview.targetReferenceMessages"), { exact: true })).toBeVisible();
  await draft.getByRole("combobox", { name: t("preview.provider"), exact: true }).selectOption("META");
  await expect(draft.getByText(t("preview.blocked"), { exact: true })).toBeVisible();
  await draft.getByRole("combobox", { name: t("preview.provider"), exact: true }).selectOption("WAHA");
  await expect(draft.getByRole("status")).toContainText(previewSummary);
  await draft.getByRole("button", { name: t("workspace.save"), exact: true }).click();
  await expect(draft).toHaveCount(0);
  const savedClosure = parseTicketEventFlow(versions[0]!.definition);
  expect(savedClosure.event).toBe("ticket_closed");
  expect(savedClosure.nodes.filter(node => node.type === "reaction")).toEqual([
    expect.objectContaining({ emoji: "✅", quote: "REFERENCE_MESSAGES" }),
  ]);
  // The route fixture preserves saved server data across a complete browser reload.
  await page.reload();
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  await page.getByRole("tab", { name: t("workspace.tab"), exact: true }).click();
  await panel.locator(".bot-version-list").getByRole("button", { name: closureName, exact: false }).click();
  const detail = panel.locator("section.panel.bot-flow-detail");
  await expect(detail.getByRole("heading", { name: closureName, exact: true })).toBeVisible();
  await expect(detail.locator('select option[value="REFERENCE_MESSAGES"]:checked')).toHaveCount(1);
  await detail.getByRole("button", { name: t("preview.run"), exact: true }).click();
  await expect(detail.getByRole("status")).toContainText(previewSummary);
  await expect(detail.getByText(t("preview.targetReferenceMessages"), { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: t("workspace.edit"), exact: true }).click();
  await expect(draft.locator('select option[value="REFERENCE_MESSAGES"]:checked')).toHaveCount(1);
  await draft.getByRole("button", { name: messages["automation.common.cancel"], exact: true }).click();
  await expect(draft).toHaveCount(0);
  expect(writes.slice(beforeClosureWrites).map(write => write.path)).toEqual(["/api/bot-flows"]);
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, dir: document.documentElement.dir }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.dir).toBe(locale === "ar" ? "rtl" : "ltr");
  await testInfo.attach(`ticket-events-${locale}`, { body: await page.screenshot({ fullPage: false, path: testInfo.outputPath("ticket-event-workflows.png") }), contentType: "image/png" });
}
