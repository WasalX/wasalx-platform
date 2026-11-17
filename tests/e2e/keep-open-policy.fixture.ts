import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { englishAutomationMessages } from "../../lib/i18n/messages/en/automation.ts";
import { arabicAutomationMessages } from "../../lib/i18n/messages/ar/automation.ts";
import { formatNumber } from "../../lib/i18n/format.ts";
import type { BotFlowDefinition } from "../../packages/core/src/bot-flow.ts";

/** Existing local portal fixture only; no activation, provider, or native-ticket effects. */
export async function keepOpenPolicyJourney(page: Page, testInfo: TestInfo, locale: "en" | "ar") {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicAutomationMessages : englishAutomationMessages;
  const number = (value: number) => formatNumber(value, locale);
  const t = (key: string, values: Record<string, string> = {}) => Object.entries(values)
    .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), messages[key]!);
  const writes: Array<{ path: string; definition: BotFlowDefinition }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (["GET", "HEAD"].includes(request.method())) { await route.continue(); return; }
    expect(request.method()).toBe("POST");
    expect(path === "/api/bot-flows" || /^\/api\/bot-flows\/[^/]+\/clone$/u.test(path), "only immutable fixture drafts may be written").toBe(true);
    expect(request.headers()["idempotency-key"]).toBeTruthy();
    writes.push({ path, definition: request.postDataJSON() as BotFlowDefinition });
    await route.continue();
  });
  const ready = async () => {
    await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.getByRole("tab", { name: t("bot.tabs.flows"), exact: true }).click();
  };
  const panel = page.locator("#bot-panel-flows");
  const editor = page.locator("form.panel.bot-flow-editor:has(#bot-flow-editor-title)");
  const policy = editor.getByRole("group", { name: t("bot.keepOpen.title"), exact: true });
  const mode = policy.getByLabel(t("bot.keepOpen.mode"));
  const pause = policy.getByLabel(t("bot.keepOpen.minutes"));
  const menu = policy.getByLabel(t("bot.keepOpen.mainMenu"));
  const resolution = policy.getByLabel(t("bot.keepOpen.customerResolution"));
  const welcome = editor.getByRole("group", { name: t("bot.welcome.title"), exact: true });
  const entrySettings = editor.getByRole("group", { name: t("bot.entry.title"), exact: true });
  const handoff = editor.locator("#bot-node-handoff");
  const entryRows = entrySettings.locator("fieldset.bot-choice-editor");
  const entryTargets: string[] = [];
  const entryLabels: string[] = [];
  const newFlow = panel.getByRole("button", { name: t("bot.flows.new"), exact: true });
  const clone = panel.getByRole("button", { name: t("bot.flow.clone"), exact: true });
  const name = `Keep-open ${locale} ${testInfo.project.name}`;
  const selectVersion = async (version: number) => {
    await panel.locator(".bot-version-list button")
      .filter({ has: page.getByText(name, { exact: true }) })
      .filter({ hasText: t("bot.flows.versionSummary", { version: number(version), assignments: number(0) }) }).click();
    await expect(clone).toBeVisible();
  };
  const save = async () => {
    const pending = page.waitForResponse(response => response.request().method() === "POST" &&
      (new URL(response.url()).pathname === "/api/bot-flows" || new URL(response.url()).pathname.endsWith("/clone")));
    await editor.getByRole("button", { name: t("bot.editor.save"), exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    await expect(editor).toHaveCount(0);
    // The UI intentionally does not consume the successful POST body. Read the
    // persisted version through the existing fixture catalog after UI completion.
    const catalog = await page.request.get("/api/bot-flows/catalog?limit=25", { timeout: 10_000 });
    expect(catalog.ok()).toBe(true);
    const { items } = await catalog.json() as { items: Array<{ flow_version_id: string; name: string; version: number }> };
    const versions = items.filter(item => item.name === name);
    expect(versions).toHaveLength(writes.length);
    const result = versions.find(item => item.version === writes.length);
    expect(result).toBeDefined();
    await page.reload();
    await ready();
    await selectVersion(result!.version);
    const detail = await page.request.get(`/api/bot-flows/${result!.flow_version_id}`, { timeout: 10_000 });
    expect(detail.ok()).toBe(true);
    return (await detail.json() as { definition: BotFlowDefinition }).definition;
  };

  await page.goto("/app?view=automation");
  await ready();
  await panel.locator(".bot-version-list button").filter({ has: page.getByText("Customer care", { exact: true }) }).first().click();
  await clone.or(panel.getByRole("button", { name: t("bot.flow.restore"), exact: true })).click();
  await expect(mode).toHaveValue("existing");
  await expect(welcome.getByLabel(t("bot.welcome.mode"))).toHaveValue("off");
  await expect(welcome.getByLabel(t("bot.mainMenu.destination"))).toHaveValue("");
  await expect(entryRows).toHaveCount(0);
  await expect(pause).toHaveCount(0);
  await editor.getByRole("button", { name: t("bot.editor.close"), exact: true }).click();
  await newFlow.click();
  await expect(mode).toHaveValue("enabled");
  await expect(pause).toHaveValue("120");
  await expect(menu).toHaveValue("true");
  await expect(resolution).toHaveValue("true");
  await mode.selectOption("existing");
  await expect(pause).toHaveCount(0);
  await mode.selectOption("enabled");
  await mode.focus();
  await mode.press("Tab");
  await expect(policy.getByLabel(t("bot.keepOpen.return"))).toBeFocused();
  for (const invalid of ["", "0", "1.5", "1441"]) {
    await pause.fill(invalid);
    await expect(editor.getByRole("alert")).toContainText(t("bot.keepOpen.minutesError", { max: number(1440) }));
    await editor.getByRole("button", { name: t("bot.editor.save"), exact: true }).click();
    expect(writes).toHaveLength(0);
  }
  await pause.fill("120");
  await welcome.getByLabel(t("bot.welcome.mode")).selectOption("on");
  await expect(welcome.getByLabel(t("bot.welcome.minutes"))).toHaveValue("60");
  for (const invalid of ["0", "1.5", "1441"]) {
    await welcome.getByLabel(t("bot.welcome.minutes")).fill(invalid);
    await expect(editor.getByRole("alert")).toContainText(t("bot.welcome.minutesError"));
    await editor.getByRole("button", { name: t("bot.editor.save"), exact: true }).click();
    expect(writes).toHaveLength(0);
  }
  await welcome.getByLabel(t("bot.welcome.minutes")).fill("60");
  await welcome.getByLabel(t("bot.mainMenu.destination")).selectOption("welcome");
  // Four synthetic declared roots are disconnected from the welcome choices.
  for (let index = 0; index < 4; index++) {
    await editor.getByLabel(t("bot.editor.newStepType")).selectOption("send_text");
    const nodes = editor.locator("fieldset.bot-node-card");
    const previousCount = await nodes.count();
    await editor.getByRole("button", { name: t("bot.editor.addStep"), exact: true }).click();
    await expect(nodes).toHaveCount(previousCount + 1);
    const node = nodes.nth(previousCount);
    await expect(node.getByLabel(t("bot.node.type"))).toHaveValue("send_text");
    const target = (await node.getAttribute("id"))!.replace("bot-node-", "");
    entryTargets.push(target);
    const label = t("ticketEvent.stepLabel", { number: number(previousCount + 1), type: t("bot.node.title.sendText") });
    entryLabels.push(label);
    await expect(node.locator("legend > span").first()).toHaveText(label);
    // Nested help and controlled textarea text participate in Playwright labels.
    const message = node.getByLabel(t("bot.node.message"));
    const next = node.getByLabel(t("bot.node.next"));
    await expect(message).toHaveCount(1);
    await expect(next).toHaveCount(1);
    await message.fill(`Synthetic topic ${index}`);
    await next.selectOption("handoff");
    await entrySettings.getByRole("button", { name: t("bot.entry.add"), exact: true }).click();
    const row = entryRows.nth(index);
    await expect(row.getByLabel(t("bot.entry.status"))).toHaveValue("false");
    await row.getByLabel(t("bot.entry.aliases")).fill(`Topic ${index}\nموضوع ${index}`);
    const destination = row.getByLabel(t("bot.entry.target"));
    await expect(destination).toHaveCount(1);
    await destination.selectOption(target);
    const options = await destination.locator("option").evaluateAll(items => items.map(item => ({ value: item.getAttribute("value"), label: item.textContent?.trim() })));
    expect(options).toContainEqual({ value: target, label });
    await expect(node.getByRole("button", { name: t("bot.node.remove"), exact: true })).toBeDisabled();
  }
  const firstStepOptions = await editor.locator("#bot-flow-start option").evaluateAll(items => items.map(item => ({ value: item.getAttribute("value"), label: item.textContent?.trim() })));
  expect(new Set(firstStepOptions.map(option => option.label)).size).toBe(firstStepOptions.length);
  for (let index = 0; index < entryTargets.length; index++) {
    expect(firstStepOptions).toContainEqual({ value: entryTargets[index], label: entryLabels[index] });
  }
  const nodeIds = await editor.locator("fieldset.bot-node-card").evaluateAll(nodes => nodes.map(node => node.id.replace("bot-node-", "")));
  const handoffLabel = t("ticketEvent.stepLabel", { number: number(nodeIds.indexOf("handoff") + 1), type: t("bot.node.title.handoff") });
  const canvas = editor.getByRole("region", { name: t("bot.canvas.region"), exact: true });
  const edge = canvas.getByRole("group", { name: t("bot.canvas.edge", { from: entryLabels[0]!, to: handoffLabel, transition: t("bot.canvas.next") }), exact: true });
  await expect(edge).toHaveCount(1);
  await expect(edge).toHaveAttribute("aria-roledescription", t("bot.canvas.edgeRole"));
  await expect(edge).toHaveAccessibleDescription(t("bot.canvas.edgeKeyboardHelp"));
  await edge.focus();
  await expect(edge).toBeFocused();
  const canvasNode = canvas.getByRole("button", { name: [t("bot.canvas.edit", { name: entryLabels[0]! }), t("bot.entry.point")].join(" · "), exact: true });
  await expect(canvasNode).toHaveAccessibleDescription(t("bot.canvas.nodeKeyboardHelp"));
  await expect(canvasNode).toHaveAttribute("aria-roledescription", t("bot.canvas.nodeRole"));
  await canvasNode.focus();
  await canvasNode.press("Enter");
  await expect(canvasNode).toHaveClass(/selected/u);
  for (let movement = 0; movement < 2; movement++) {
    const originalPosition = await canvasNode.evaluate(element => {
      const transform = (element as HTMLElement).style.transform, matrix = new DOMMatrixReadOnly(transform);
      return { transform, x: Math.trunc(matrix.m41), y: Math.trunc(matrix.m42) };
    });
    await canvasNode.press("ArrowRight");
    await expect(canvas.locator('[id^="react-flow__aria-live-"]')).toHaveText(t("bot.canvas.nodeMoved", { x: number(originalPosition.x), y: number(originalPosition.y) }));
    await expect.poll(() => canvasNode.evaluate(element => (element as HTMLElement).style.transform)).not.toBe(originalPosition.transform);
  }
  await canvasNode.press("Escape");
  await expect(canvasNode).not.toHaveClass(/selected/u);
  const nextOptions = await editor.locator(`#bot-node-${entryTargets[0]} select[id$="-next"] option`).evaluateAll(items => items.map(item => ({ value: item.getAttribute("value"), label: item.textContent?.trim() })));
  expect(nextOptions).toContainEqual({ value: "handoff", label: handoffLabel });
  const menuOptions = await welcome.getByLabel(t("bot.mainMenu.destination")).locator("option").evaluateAll(items => items.map(item => ({ value: item.getAttribute("value"), label: item.textContent?.trim() })));
  const welcomeLabel = t("ticketEvent.stepLabel", { number: number(nodeIds.indexOf("welcome") + 1), type: t("bot.node.title.choice") });
  expect(menuOptions).toContainEqual({ value: "welcome", label: welcomeLabel });
  const presentation = await editor.locator("fieldset.bot-node-card > legend, select option, .react-flow__node, .react-flow__edge").evaluateAll(elements => elements.map(element => element.matches(".react-flow__node, .react-flow__edge") ? element.getAttribute("aria-label") : element.textContent).join("\n"));
  for (const target of entryTargets) expect(presentation).not.toContain(target);
  expect(presentation).not.toMatch(/\bhandoff\b/u);
  for (const invalid of ["1", "Main menu", "Topic 1"]) {
    await entryRows.first().getByLabel(t("bot.entry.aliases")).fill(invalid);
    await expect(editor.getByRole("alert")).toContainText(t("bot.entry.invalid"));
    await editor.getByRole("button", { name: t("bot.editor.save"), exact: true }).click();
    expect(writes).toHaveLength(0);
  }
  await entryRows.first().getByLabel(t("bot.entry.aliases")).fill("Topic 0\nموضوع 0");
  await entryRows.first().getByLabel(t("bot.entry.status")).selectOption("true");
  await pause.fill("90");
  await menu.selectOption("false");
  await editor.getByLabel(t("bot.editor.name")).fill(name);
  await expect(editor.getByText(t("bot.editor.localSaved"), { exact: true })).toBeVisible();
  await page.reload();
  await ready();
  await newFlow.click();
  await expect(page.getByText(t("bot.notice.recovered"), { exact: true })).toBeVisible();
  await expect(pause).toHaveValue("90");
  await expect(menu).toHaveValue("false");
  await expect(resolution).toHaveValue("true");
  await expect(welcome.getByLabel(t("bot.welcome.minutes"))).toHaveValue("60");
  await expect(welcome.getByLabel(t("bot.mainMenu.destination"))).toHaveValue("welcome");
  await expect(entryRows).toHaveCount(4);
  for (let index = 0; index < 4; index++) {
    await expect(entryRows.nth(index).getByLabel(t("bot.entry.target"))).toHaveValue(entryTargets[index]!);
    await expect(entryRows.nth(index).getByLabel(t("bot.entry.status"))).toHaveValue(String(index === 0));
  }
  await menu.selectOption("true");
  const handoffMenu = handoff.getByLabel(t("bot.mainMenu.handoff"));
  await expect(handoffMenu).toHaveCount(1);
  await handoffMenu.selectOption("custom");
  const returnLabel = handoff.getByLabel(t("bot.mainMenu.label"));
  await expect(returnLabel).toHaveCount(1);
  for (const invalid of [" Menu", "Menu ", "\tMenu", "القائمة الرئيسية\u00a0", "😀".repeat(21)]) {
    await returnLabel.fill(invalid);
    await expect(returnLabel).toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByRole("alert")).toContainText(t("bot.mainMenu.labelError"));
    await expect(handoff.locator("small[id$='-main-menu-label-help']")).toHaveText(t("bot.mainMenu.labelError"));
    await editor.getByRole("button", { name: t("bot.editor.save"), exact: true }).click();
    expect(writes).toHaveLength(0);
  }
  for (const valid of ["القائمة الرئيسية", "😀".repeat(20)]) {
    await returnLabel.fill(valid);
    await expect(returnLabel).toHaveAttribute("aria-invalid", "false");
    await expect(editor.getByRole("alert")).toHaveCount(0);
  }
  const customReturnLabel = locale === "ar" ? "العودة للمبيعات" : "Return to sales";
  await returnLabel.fill(customReturnLabel);
  const handoffDestination = handoff.getByLabel(t("bot.node.handoffDestination"));
  await expect(handoffDestination).toHaveCount(1);
  await handoffDestination.selectOption("CLIENT_ESCALATION");
  await expect(returnLabel).toHaveValue(customReturnLabel);
  await handoffDestination.selectOption("CLIENT_PRIMARY");
  await handoffDestination.selectOption("FIXED");
  const fixedTeam = handoff.getByRole("combobox", { name: t("bot.node.teamReference"), exact: true });
  await expect(fixedTeam).toHaveCount(1);
  await fixedTeam.selectOption("2");
  await expect(returnLabel).toHaveValue(customReturnLabel);
  for (const [label, section] of [["rc2-welcome", welcome], ["rc2-entries", entrySettings], ["rc2-handoff", handoff]] as const) {
    await section.scrollIntoViewIfNeeded();
    const bounds = await section.evaluate(element => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      controls: [...element.querySelectorAll("input,select,textarea,button")].map(control => {
        const rect = control.getBoundingClientRect(); return { id: control.id, height: rect.height, left: rect.left, right: rect.right };
      }) }));
    await testInfo.attach(`${label}-geometry`, { body: JSON.stringify(bounds, null, 2), contentType: "application/json" });
    await page.screenshot({ fullPage: false, path: testInfo.outputPath(`${label}.png`) });
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
    if (testInfo.project.name === "mobile-390") for (const control of bounds.controls) {
      expect(control.height, control.id).toBeGreaterThanOrEqual(44);
      expect(control.left, control.id).toBeGreaterThanOrEqual(0);
      expect(control.right, control.id).toBeLessThanOrEqual(391);
    }
  }
  expect((await new AxeBuilder({ page }).include("fieldset.bot-flow-settings:has(#bot-welcome-mode)").include("fieldset.bot-flow-settings:has(#bot-entry-help)").include("#bot-node-handoff").analyze()).violations).toEqual([]);
  await policy.scrollIntoViewIfNeeded();
  const geometry = await policy.evaluate(element => ({
    viewport: { width: innerWidth, height: innerHeight, coarse: matchMedia("(any-pointer: coarse)").matches },
    pageWidth: document.documentElement.scrollWidth,
    controls: [...element.querySelectorAll("input,select")].map(control => {
      const rect = control.getBoundingClientRect();
      return { id: control.id, width: rect.width, height: rect.height, left: rect.left, right: rect.right };
    }),
  }));
  await testInfo.attach("keep-open-policy-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
  await testInfo.attach("keep-open-policy", { body: await page.screenshot({ fullPage: false, path: testInfo.outputPath("keep-open-policy.png") }), contentType: "image/png" });
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport.width + 1);
  if (testInfo.project.name === "mobile-390") {
    expect(geometry.viewport).toEqual({ width: 390, height: 844, coarse: true });
    for (const control of geometry.controls) {
      expect(control.height, control.id).toBeGreaterThanOrEqual(44);
      expect(control.left, control.id).toBeGreaterThanOrEqual(0);
      expect(control.right, control.id).toBeLessThanOrEqual(391);
    }
  }
  expect((await new AxeBuilder({ page }).include("fieldset.bot-flow-settings:has(#bot-keep-open-mode)").analyze()).violations).toEqual([]);
  await pause.fill("120");
  const enabled = await save();
  expect(enabled.keepOpenPolicy).toEqual({ humanReplyPauseMinutes: 120, mainMenu: true, customerResolution: true });
  expect(enabled.welcomeResendMinutes).toBe(60);
  expect(enabled.mainMenuNodeId).toBe("welcome");
  expect(enabled.entryCommands).toEqual(entryTargets.map((target, index) => ({ id: `entry_${index + 1}`, aliases: [`Topic ${index}`, `موضوع ${index}`], target, enabled: index === 0 })));
  expect(enabled.nodes.find(node => node.id === "handoff")).toMatchObject({ target: "FIXED", zammadGroupId: "2", mainMenuReturn: { label: customReturnLabel } });
  const savedHandoff = panel.locator(".bot-flow-detail .bot-node-list > li").filter({ hasText: customReturnLabel });
  await expect(savedHandoff).toHaveCount(1);
  await expect(savedHandoff).toContainText(t("bot.node.title.handoff"));
  await expect(savedHandoff).toContainText("Riyadh Operations");
  await expect(savedHandoff).toContainText(customReturnLabel);
  await savedHandoff.scrollIntoViewIfNeeded();
  const savedHandoffGeometry = await savedHandoff.evaluate(element => {
    const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageWidth: document.documentElement.scrollWidth,
      dir: document.documentElement.dir,
      row: { left, right, top, bottom, width, height },
    };
  });
  await testInfo.attach("persisted-handoff-geometry", {
    body: JSON.stringify(savedHandoffGeometry, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("persisted-handoff", {
    body: await savedHandoff.screenshot({ path: testInfo.outputPath("persisted-handoff.png") }),
    contentType: "image/png",
  });
  expect(savedHandoffGeometry.pageWidth).toBeLessThanOrEqual(savedHandoffGeometry.viewport.width + 1);
  expect(savedHandoffGeometry.row.left).toBeGreaterThanOrEqual(0);
  expect(savedHandoffGeometry.row.right).toBeLessThanOrEqual(savedHandoffGeometry.viewport.width + 1);
  const simulator = panel.locator(".bot-simulator");
  const previewEntry = simulator.getByLabel(t("bot.entry.preview"));
  await expect(previewEntry).toHaveCount(1);
  await previewEntry.fill("موضوع 0");
  await simulator.getByRole("button", { name: t("bot.entry.try"), exact: true }).click();
  await expect(simulator.locator(".bot-transcript")).toContainText("Synthetic topic 0");
  await simulator.getByRole("button", { name: customReturnLabel, exact: true }).click();
  await expect(simulator.getByRole("button", { name: t("bot.starter.support.agent"), exact: true })).toBeVisible();
  await clone.click();
  await expect(pause).toHaveValue("120");
  await expect(returnLabel).toHaveValue(customReturnLabel);
  await handoffMenu.selectOption("generated");
  await menu.selectOption("false");
  await policy.getByLabel(t("bot.keepOpen.return")).selectOption("off");
  await resolution.selectOption("false");
  await expect(pause).toHaveCount(0);
  const disabled = await save();
  expect(disabled.keepOpenPolicy).toEqual({ humanReplyPauseMinutes: null, mainMenu: false, customerResolution: false });
  expect(disabled.entryCommands).toEqual(enabled.entryCommands);
  expect(disabled.welcomeResendMinutes).toBe(60);
  expect(disabled.mainMenuNodeId).toBe("welcome");
  expect(disabled.nodes.find(node => node.id === "handoff")).not.toHaveProperty("mainMenuReturn");
  await expect(panel.getByText(t("bot.comparison.setting.keepOpenPolicy"), { exact: true })).toBeVisible();
  await expect(panel.getByText(t("bot.comparison.summary", { added: number(0), removed: number(0), changed: number(2) }), { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: t("bot.flow.review"), exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: t("automation.common.cancel"), exact: true }).click();
  await clone.click();
  await mode.selectOption("existing");
  expect("keepOpenPolicy" in await save()).toBe(false);
  expect(writes).toHaveLength(3);
  expect(writes.map(write => write.definition.keepOpenPolicy)).toEqual([enabled.keepOpenPolicy, disabled.keepOpenPolicy, undefined]);
}
