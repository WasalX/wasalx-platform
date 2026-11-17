import { useCallback, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { I18nProvider } from "../I18nProvider";
import { ServiceAccess } from "../ServiceAccess";
import { SupportTeams } from "../SupportTeams";
import { getMessages } from "../../lib/i18n/messages";
import "../globals.css";
function Workspace({ locale = "en", protectedOwner = false }: { locale?: "en" | "ar"; protectedOwner?: boolean }) {
  const [team, setTeam] = useState<string | null>("2");
  const execute = useCallback(async <T,>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const response = await fetch("/api/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }), signal });
    const result = await response.json() as { code?: string };
    if (!response.ok) throw Object.assign(new Error("Synthetic service access failure"), { status: response.status, code: result.code });
    return result as T;
  }, []);
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={1792252800000}><main className="wx-story-section" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>{protectedOwner ? <SupportTeams execute={execute} scope="storybook:synthetic-protected-owner" owner/> : <div className="panel"><ServiceAccess execute={execute} scope="storybook:synthetic-service-access" teamId={team}/><button type="button" className="button secondary" onClick={() => setTeam(team === "2" ? "3" : "2")}>Synthetic selection change</button></div>}</main></I18nProvider>;
}
export default { title: "Product/Service access", component: Workspace, parameters: { layout: "fullscreen", docs: { description: { component: "Actual owner service-access component; browser fixtures are synthetic exploratory UI evidence, never native identity or provider acceptance." } } } } satisfies Meta<typeof Workspace>;
type Story = StoryObj<typeof Workspace>;
export const English: Story = {};
export const Arabic: Story = { args: { locale: "ar" } };
export const ProtectedOwnerEnglish: Story = { args: { protectedOwner: true } };
export const ProtectedOwnerArabic: Story = { args: { protectedOwner: true, locale: "ar" } };
