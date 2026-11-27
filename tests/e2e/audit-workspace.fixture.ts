import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { englishTenantMessages } from "../../lib/i18n/messages/en/tenant";
import { arabicTenantMessages } from "../../lib/i18n/messages/ar/tenant";

/** Public HTTP fixtures exercise presentation and download; controller projection is tested separately. */
export async function auditWorkspaceJourney(page: Page, locale: "en" | "ar", role: string, info: TestInfo) {
  const copy: Readonly<Record<string, string>> = locale === "ar" ? arabicTenantMessages : englishTenantMessages;
  const actions = [
    ["group_workspace.ticket_linked", "groupTicketLinked"], ["group_workspace.read", "groupRead"],
    ["group_workspace.message_queued", "groupMessageQueued"], ["group_workspace.reaction_queued", "groupReactionQueued"],
    ["group_workspace.reaction_removal_queued", "groupReactionRemovalQueued"],
    ["workspace_email.route_pinned", "mailRoutePinned"], ["workspace_email.route_applied", "mailRouteApplied"],
    ["workspace_email.route_manually_overridden", "mailRouteOverridden"],
    ["delivery.retry_requested_from_workspace", "workspaceDeliveryRetry"],
    ["connection.meta_number_released", "metaNumberReleased"],
  ];
  const rows = actions.map(([action], index) => ({
    id: `audit-workspace-${index}`, action, detail: action,
    actor_type: ["WORKSPACE_USER", "WORKSPACE_AGENT", "USER", "SYSTEM", "PLATFORM_OPERATOR", "SERVICE"][index % 6],
    actor_id: `actor-reference-${index}`, actor: index % 6 === 2 ? "Maya Al-Salem" : "42",
    actor_display_name: index % 6 === 2 ? "Maya Al-Salem" : null,
    target: `ticket-reference-${index}`, request_id: `exact-request-${index}`,
    created_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
  }));
  const csv = '\uFEFF"actor_type","actor_id","action","request_id"\r\n"WORKSPACE_USER","actor-reference-0","group_workspace.ticket_linked","exact-request-0"\r\n';
  const requests: string[] = [];
  await page.route("**/api/audit?*", async route => {
    requests.push(route.request().method());
    await route.fulfill({ json: rows });
  });
  await page.route("**/api/audit/export?*", async route => {
    requests.push(route.request().method());
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("from")).toMatch(/T00:00:00\.000Z$/u);
    expect(query.get("to")).toMatch(/T23:59:59\.999Z$/u);
    expect(query.get("limit")).toBe("5000");
    await route.fulfill({ contentType: "text/csv; charset=utf-8", headers: { "content-disposition": 'attachment; filename="wasalx-audit-fixture.csv"' }, body: csv });
  });
  await page.goto("/app?view=audit");
  await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
  const exportButton = page.getByRole("button", { name: copy["tenant.audit.export.open"], exact: true });
  if (role === "agent") {
    await expect(page.getByRole("link", { name: copy["tenant.navigation.audit"], exact: true })).toHaveCount(0);
    await expect(page.locator(".audit-row")).toHaveCount(0);
    await expect(exportButton).toHaveCount(0);
    expect(requests).toEqual([]);
    return;
  }
  await expect(page.getByRole("heading", { level: 1, name: copy["tenant.title.audit"], exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: copy["tenant.audit.scope.label"] }).selectOption("include");
  const entries = page.locator(".audit-row");
  await expect(entries).toContainText(actions.map(([, key]) => copy[`tenant.audit.action.${key}`]));
  await expect(entries).toHaveCount(rows.length);
  for (const [index, row] of rows.entries()) {
    await expect(entries.nth(index)).toContainText(index % 6 === 2 ? "Maya Al-Salem" : copy[`tenant.audit.actor.${["member", "agent", "member", "automation", "support", "automation"][index % 6]}`]);
    if (role === "auditor") await expect(entries.nth(index)).toContainText(row.actor_id);
    else await expect(entries.nth(index)).not.toContainText(row.actor_id);
  }
  await expect(page.locator(".timeline")).not.toContainText(/zammad|group_workspace\.|workspace_email\.|connection\.meta_number_released/iu);
  const search = page.getByPlaceholder(copy["tenant.audit.search"], { exact: true });
  await search.fill(copy["tenant.audit.action.mailRoutePinned"]);
  await expect(entries).toHaveCount(1);
  await search.fill("NO_MATCH_AUDIT");
  await expect(page.getByText(copy["tenant.audit.noMatchesTitle"], { exact: true })).toBeVisible();
  await search.fill("");
  await expect(entries).toHaveCount(rows.length);
  if (info.project.name === "tablet-820") {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(820);
    await info.attach("audit-workspace-dark", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: copy["tenant.theme.switchLight"], exact: true }).click();
    const darkThemeButton = page.getByRole("button", { name: copy["tenant.theme.switchDark"], exact: true });
    await expect(darkThemeButton).toBeVisible();
    await info.attach("audit-workspace-light", { body: await page.screenshot(), contentType: "image/png" });
    await darkThemeButton.click();
  } else if (["tenant_owner", "auditor"].includes(role)) {
    await info.attach("audit-workspace", { body: await page.screenshot(), contentType: "image/png" });
  }
  expect((await new AxeBuilder({ page }).include(".table-panel").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  if (role === "supervisor") await expect(exportButton).toHaveCount(0);
  else {
    await exportButton.click();
    const dialog = page.getByRole("dialog", { name: copy["tenant.audit.export.title"], exact: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await exportButton.click();
    const downloaded = page.waitForEvent("download");
    await dialog.getByRole("button", { name: copy["tenant.audit.export.download"], exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("wasalx-audit-fixture.csv");
    expect(await readFile((await download.path())!, "utf8")).toBe(csv);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: locale === "ar" ? "CSV" : "Audit CSV downloaded" })).toBeVisible();
  }
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(method => method === "GET")).toBe(true);
}
