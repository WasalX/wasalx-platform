import { expect, test, type ConsoleMessage, type Page, type Request, type Route } from "@playwright/test";
import type { TeamAccessData } from "../../lib/control-plane-data";
import { arabicMessages } from "../../lib/i18n/messages/ar/index.ts";
import { englishMessages } from "../../lib/i18n/messages/en/index.ts";

const now = "2026-11-28T12:00:00.000Z";
const member = {
  id: "32000000-0000-4000-8000-000000000061",
  user_id: "32000000-0000-4000-8000-000000000062",
  email: "team-member@example.test",
  display_name: "Team member fixture",
  role: "agent",
  state: "ACTIVE",
  version: 12,
  created_at: now,
  updated_at: now,
  is_current_user: false,
  whatsapp_numbers: [],
};
const invitation = {
  id: "32000000-0000-4000-8000-000000000063",
  email: "team-invite@example.test",
  display_name: null,
  role: "agent",
  state: "PENDING",
  version: 7,
  created_at: now,
  updated_at: now,
  expires_at: "2026-12-05T12:00:00.000Z",
  delivery_state: "SENT",
};
const unknownInvitation = {
  ...invitation,
  id: "32000000-0000-4000-8000-000000000064",
  email: "team-invite-unknown@example.test",
  delivery_state: "FAILED_TERMINAL",
  delivery_error_code: "INVITATION_DELIVERY_OUTCOME_UNKNOWN",
};
const invitationsPath = "/api/team/invitations";
const memberPath = `/api/team/members/${member.id}`;

const expectedErrors = new WeakMap<Page, { url: string; status: number }>();

export function consumeExpectedTeamActionError(page: Page, message: ConsoleMessage) {
  const error = expectedErrors.get(page);
  if (
    !error || message.type() !== "error" || message.location().url !== error.url ||
    !message.text().startsWith("Failed to load resource:") ||
    message.text().match(/\b(?:409|503)\b/u)?.[0] !== String(error.status)
  ) return false;
  expectedErrors.delete(page);
  return true;
}

async function fulfillError(page: Page, route: Route, status: number) {
  expectedErrors.set(page, { url: route.request().url(), status });
  await route.fulfill({ status, json: {} });
}

function teamData(canManage: boolean): TeamAccessData {
  return {
    members: [member],
    invitations: [invitation],
    capabilities: {
      can_invite: canManage,
      can_manage_members: canManage,
      can_manage_owners: false,
    },
  };
}

export function registerTeamActionJourneys(
  locale: "en" | "ar",
  role: string,
  open: (page: Page, view: string) => Promise<void>,
) {
  const messages = locale === "ar" ? arabicMessages : englishMessages;
  const t = (key: keyof typeof englishMessages) => messages[key];
  const isolation = (value: string) => `\u2068${value}\u2069`;
  const memberRow = (page: Page) => page.getByRole("row").filter({ hasText: member.email });
  const invitationRow = (page: Page, email: string) => page.getByRole("article").filter({ hasText: email });
  const notice = (page: Page) => page.locator('.team-feedback[role="status"]');

  async function openTeam(page: Page, data: TeamAccessData) {
    await page.clock.setFixedTime(new Date(now));
    await page.route("**/api/team", route => route.fulfill({ json: data }));
    const writes: Request[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/team/") && request.method() !== "GET") {
        writes.push(request);
      }
    });
    await open(page, "team");
    return writes;
  }

  async function manageMember(page: Page) {
    await memberRow(page).getByRole("button", {
      name: t("tenant.team.actions.manage"), exact: true,
    }).click();
    return page.getByRole("dialog", {
      name: `${t("tenant.team.member.title")} ${member.display_name}`, exact: true,
    });
  }

  if (role === "supervisor" || role === "auditor") {
    test("Team read-only roles see no invitation or membership actions", async ({ page }) => {
      const data = teamData(false);
      data.invitations.push(unknownInvitation);
      const writes = await openTeam(page, data);
      await expect(memberRow(page).getByText(t("tenant.team.readOnly"), { exact: true })).toBeVisible();
      const team = page.locator(".team-layout");
      await expect(team.getByText(t("tenant.team.invitations.restrictedBody"), { exact: true })).toBeVisible();
      for (const key of ["invite", "manage", "resend", "reviewResend", "revoke"] as const) {
        await expect(team.getByRole("button", { name: t(`tenant.team.actions.${key}`), exact: true })).toHaveCount(0);
      }
      expect(writes).toHaveLength(0);
    });
  }

  if (role !== "tenant_admin") return;

  test("Team resend reuses its key on retry and verifies unknown delivery", async ({ page }) => {
    const data = teamData(true);
    data.invitations.push(unknownInvitation);
    const resendPath = `${invitationsPath}/${invitation.id}/resend`;
    const unknownPath = `${invitationsPath}/${unknownInvitation.id}/resend`;
    let attempts = 0;
    await page.route(`**${resendPath}`, async route => {
      if (++attempts === 1) return fulfillError(page, route, 503);
      data.invitations[0] = { ...invitation, version: 8, delivery_state: "PENDING" };
      await route.fulfill({ json: data.invitations[0] });
    });
    await page.route(`**${unknownPath}`, async route => {
      data.invitations[1] = { ...unknownInvitation, version: 8, delivery_state: "PENDING", delivery_error_code: null };
      await route.fulfill({ json: data.invitations[1] });
    });
    const writes = await openTeam(page, data);
    const resend = invitationRow(page, invitation.email).getByRole("button", {
      name: t("tenant.team.actions.resend"), exact: true,
    });
    await resend.click();
    await expect(page.locator('.team-feedback[role="alert"]')).toContainText(t("common.errors.unavailable"));
    await expect(notice(page)).toHaveCount(0);
    await resend.click();
    await expect(notice(page)).toContainText(t("tenant.team.notice.resent").replace("{email}", isolation(invitation.email)));
    expect(writes).toHaveLength(2);
    const key = writes[0].headers()["idempotency-key"];
    expect(key).toBeTruthy();
    expect(writes[1].headers()["idempotency-key"]).toBe(key);
    for (const request of writes) {
      expect(new URL(request.url()).pathname).toBe(resendPath);
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON()).toEqual({ expiresInDays: 7, confirmUnknownDelivery: false });
    }

    await invitationRow(page, unknownInvitation.email).getByRole("button", {
      name: t("tenant.team.actions.reviewResend"), exact: true,
    }).click();
    const confirmation = page.getByRole("alertdialog", { name: t("tenant.team.resendConfirmation.title") });
    await expect(confirmation).toBeVisible();
    const verifiedResend = confirmation.getByRole("button", { name: t("tenant.team.actions.verifiedResend") });
    await expect(verifiedResend).toBeDisabled();
    expect(writes).toHaveLength(2);
    await confirmation.getByRole("textbox").fill(t("tenant.team.resendConfirmation.token"));
    await verifiedResend.click();
    await expect(notice(page)).toContainText(t("tenant.team.notice.resent").replace("{email}", isolation(unknownInvitation.email)));
    expect(writes).toHaveLength(3);
    expect(new URL(writes[2].url()).pathname).toBe(unknownPath);
    expect(writes[2].method()).toBe("POST");
    expect(writes[2].postDataJSON()).toEqual({ expiresInDays: 7, confirmUnknownDelivery: true });
  });

  test("Team revokes the current invitation and keeps its revoked history", async ({ page }) => {
    const data = teamData(true);
    const revokePath = `${invitationsPath}/${invitation.id}/revoke`;
    await page.route(`**${revokePath}`, async route => {
      data.invitations[0] = { ...invitation, state: "REVOKED", version: 8, delivery_state: "CANCELLED" };
      await route.fulfill({ json: data.invitations[0] });
    });
    const writes = await openTeam(page, data);
    const row = invitationRow(page, invitation.email);
    const revoke = row.getByRole("button", { name: t("tenant.team.actions.revoke"), exact: true });
    await revoke.click();
    await expect(notice(page)).toContainText(t("tenant.team.notice.revoked").replace("{email}", isolation(invitation.email)));
    await expect(row.getByText(t("tenant.status.revoked"), { exact: true })).toBeVisible();
    await expect(revoke).toHaveCount(0);
    await expect(row.getByRole("button", { name: t("tenant.team.actions.resend"), exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(new URL(writes[0].url()).pathname).toBe(revokePath);
    expect(writes[0].method()).toBe("POST");
    expect(writes[0].postDataJSON()).toEqual({ expectedVersion: invitation.version });
  });

  test("Team updates a role and keeps a conflicted suspend open", async ({ page }) => {
    const data = teamData(true);
    const owner = {
      ...member,
      id: "32000000-0000-4000-8000-000000000065",
      user_id: "32000000-0000-4000-8000-000000000066",
      email: "team-owner@example.test",
      display_name: "Team owner fixture",
      role: "tenant_owner",
    };
    data.members.push(owner);
    const updated = { ...member, role: "supervisor", version: 13 };
    await page.route(`**${memberPath}`, async route => {
      if (data.members[0] === updated) return fulfillError(page, route, 409);
      data.members[0] = updated;
      await route.fulfill({ json: updated });
    });
    const writes = await openTeam(page, data);
    const ownerRow = page.getByRole("row").filter({ hasText: owner.email });
    await expect(ownerRow.getByText(t("tenant.team.ownerOnly"), { exact: true })).toBeVisible();
    await expect(ownerRow.getByRole("button", { name: t("tenant.team.actions.manage"), exact: true })).toHaveCount(0);
    const dialog = await manageMember(page);
    const roles = dialog.getByRole("combobox", { name: t("tenant.team.invite.role") });
    await expect(roles.locator('option[value="tenant_owner"]')).toHaveCount(0);
    await roles.selectOption({ label: t("tenant.role.supervisor") });
    const save = dialog.getByRole("button", { name: t("tenant.team.member.save") });
    await save.click();
    const updatedMessage = t("tenant.team.notice.updated").replace("{name}", isolation(member.display_name));
    await expect(notice(page)).toContainText(updatedMessage);
    await expect(dialog).toHaveCount(0);
    await expect(memberRow(page).getByText(t("tenant.role.supervisor"), { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].postDataJSON()).toEqual({
      role: "supervisor", state: "ACTIVE", expectedVersion: member.version, whatsappNumbers: [],
    });

    // Start a fresh view so any success notice would come from this PATCH.
    await open(page, "team");
    await manageMember(page);
    await dialog.getByRole("combobox", { name: t("tenant.team.member.state") })
      .selectOption({ label: t("tenant.team.member.stateSuspended") });
    await save.click();
    await expect(dialog.getByRole("alert")).toContainText(t("common.errors.conflict"));
    await expect(dialog).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(writes[1].postDataJSON()).toEqual({
      role: "supervisor", state: "SUSPENDED", expectedVersion: updated.version, whatsappNumbers: [],
    });
    for (const request of writes) {
      expect(new URL(request.url()).pathname).toBe(memberPath);
      expect(request.method()).toBe("PATCH");
    }
  });

  test("Team removal keeps the member until confirmed and sends its version", async ({ page }) => {
    const data = teamData(true);
    await page.route(`**${memberPath}`, async route => {
      data.members = [];
      await route.fulfill({ json: { removed: true } });
    });
    const writes = await openTeam(page, data);
    const dialog = await manageMember(page);
    const remove = dialog.getByRole("button", { name: t("tenant.team.member.remove"), exact: true });
    const confirmation = page.getByRole("alertdialog", { name: t("tenant.team.member.removeTitle") });
    await remove.click();
    await expect(confirmation).toBeVisible();
    expect(writes).toHaveLength(0);
    await confirmation.getByRole("button", { name: t("tenant.team.member.keep") }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(remove).toBeVisible();
    expect(writes).toHaveLength(0);

    await remove.click();
    await confirmation.getByRole("button", { name: t("tenant.team.member.removeAccess") }).click();
    await expect(notice(page)).toContainText(t("tenant.team.notice.removed").replace("{name}", isolation(member.display_name)));
    await expect(memberRow(page)).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(new URL(writes[0].url()).pathname).toBe(memberPath);
    expect(writes[0].method()).toBe("DELETE");
    expect(writes[0].postDataJSON()).toEqual({ expectedVersion: member.version });
  });
}
