import { useCallback } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { I18nProvider } from "../I18nProvider";
import { SupportTeams } from "../SupportTeams";
import { MailboxSettings } from "../MailboxSettings";
import { MailboxAdministration } from "../MailboxAdministration";
import "../globals.css";

const teams = [{ id: "2", name: "Synthetic customer support" }, { id: "3", name: "Synthetic accounts" }];
function Administration({ locale = "en", surface = "teams" }: { locale?: "en" | "ar"; surface?: "teams" | "settings" | "administration" }) {
  const execute = useCallback(async <T,>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const response = await fetch("/api/inbox", { method: "POST", cache: "no-store", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) });
    const result = await response.json() as { code?: string; error?: string };
    if (!response.ok) throw Object.assign(new Error("Synthetic bridge request failed"), { status: response.status, code: result.code });
    return result as T;
  }, []);
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={1792252800000}>
    <main lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} className="wx-story-section">
      {surface === "teams" ? <SupportTeams execute={execute} scope="storybook:synthetic-admin-teams" />
        : surface === "settings" ? <MailboxSettings execute={execute} scope="storybook:synthetic-admin-settings" teams={teams} />
          : <MailboxAdministration execute={execute} scope="storybook:synthetic-admin-administration" />}
    </main>
  </I18nProvider>;
}

export default { title: "Product/Administration", component: Administration,
  args: { locale: "en" },
  parameters: { layout: "fullscreen", docs: { description: {
    component: "Actual WasalX administration components. Browser tests supply a synthetic bridge. Captures and interaction results are exploratory UI evidence; they do not prove native, email, network verification or provider behavior.",
  } } },
} satisfies Meta<typeof Administration>;
type Story = StoryObj<typeof Administration>;
export const SupportTeamsEnglish: Story = { args: { surface: "teams", locale: "en" } };
export const SupportTeamsArabic: Story = { args: { surface: "teams", locale: "ar" } };
export const MailboxSettingsEnglish: Story = { args: { surface: "settings", locale: "en" } };
export const MailboxSettingsArabic: Story = { args: { surface: "settings", locale: "ar" } };
export const MailboxAdministrationEnglish: Story = { args: { surface: "administration", locale: "en" } };
export const MailboxAdministrationArabic: Story = { args: { surface: "administration", locale: "ar" } };
