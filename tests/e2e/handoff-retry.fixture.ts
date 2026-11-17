import { expect, type Page } from "@playwright/test";
import { englishAutomationMessages } from "../../lib/i18n/messages/en/automation.ts";
import { arabicAutomationMessages } from "../../lib/i18n/messages/ar/automation.ts";

export async function handoffRetryJourney(page: Page, locale: "en" | "ar", role: string) {
  const messages: Readonly<Record<string, string>> = locale === "ar" ? arabicAutomationMessages : englishAutomationMessages;
  const rows = ["FAILED_RETRYABLE", "RUNNING", "QUEUED", "SUCCEEDED", "FAILED_TERMINAL"].map((state, index) => ({
    id: `47000000-0000-4000-8000-00000000000${index + 1}`,
    flow_version_id: "82000000-0000-4000-8000-000000000001",
    state: state === "SUCCEEDED" ? "HUMAN" : "HANDOFF_PENDING",
    handoff_state: state, handoff_attempts: 7, fencing_token: 4, current_node_id: "handoff", step_count: 3,
    zammad_ticket_number: `1043${index}`, connection_name: "QA retry line", connection_provider: "WAHA",
    flow_name: "QA retry flow", version: 1, last_activity_at: "2026-10-15T16:24:42.689Z",
    handoff_safe_error: state === "FAILED_RETRYABLE" ? "Support workspace unavailable" : null,
  }));
  let writes = 0, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/bot-flows/conversations?*", route => route.fulfill({ json: { items: rows, next_cursor: null } }));
  await page.route(`**/api/bot-flows/conversations/${rows[0].id}/command`, async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({ action: "RETRY_HANDOFF", expectedFencingToken: 4 });
    writes++;
    await gate;
    rows[0].handoff_state = "QUEUED"; rows[0].fencing_token = 5; rows[0].handoff_safe_error = null;
    await route.fulfill({ json: { conversationId: rows[0].id, state: "HANDOFF_PENDING", fencingToken: 5, command: "RETRY_HANDOFF" } });
  });
  const open = async () => {
    await page.goto("/app?view=automation");
    await expect(page.locator('[data-application-ready="true"]')).toBeVisible();
    await page.getByRole("tab", { name: messages["bot.tabs.conversations"], exact: true }).click();
  };
  await open();
  const conversation = page.locator(".bot-conversation-list article").filter({ hasText: "#10430" });
  const retry = conversation.getByRole("button", { name: messages["bot.conversations.retryHandoff"], exact: true });
  await expect(conversation).toBeVisible();
  await expect(conversation.getByRole("button", { name: messages["bot.command.resume"], exact: true })).toHaveCount(0);
  await expect(conversation.getByRole("button", { name: messages["bot.command.close"], exact: true })).toHaveCount(0);
  for (const ticket of ["10431", "10432", "10433"])
    await expect(page.locator(".bot-conversation-list article").filter({ hasText: `#${ticket}` }).getByRole("button", { name: messages["bot.conversations.retryHandoff"], exact: true })).toHaveCount(0);
  await expect(page.locator(".bot-conversation-list article").filter({ hasText: "#10434" }).getByRole("button", { name: messages["bot.conversations.retryHandoff"], exact: true })).toHaveCount(role === "auditor" ? 0 : 1);
  if (role === "auditor") { await expect(retry).toHaveCount(0); expect(writes).toBe(0); return; }
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect.poll(() => writes).toBe(1);
  release();
  await expect(retry).toHaveCount(0);
  await open();
  await expect(retry).toHaveCount(0);
  expect(writes).toBe(1);
}
