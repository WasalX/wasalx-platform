import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { getMessages } from "../../lib/i18n/messages";
import { I18nProvider, useI18n } from "../I18nProvider";
import { PrivacyHoldDialog, PrivacyRequestDialog } from "../TenantSettings";
import "../globals.css";

const headers = { "content-type": "application/json" };
function Dialog({ kind }: { kind: "hold" | "export" | "delete" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true), [complete, setComplete] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const finish = async () => { setOpen(false); setComplete(true); };
  const recover = () => { setOpen(false); setRecovered(true); };
  return <main className="wx-story-section">
    <h1>{t("tenant.privacy.policy.title")}</h1>
    <button type="button" className="button secondary" onClick={() => { setOpen(true); setComplete(false); }}>{t(kind === "hold" ? "tenant.privacy.action.createHold" : kind === "delete" ? "tenant.privacy.action.requestDeletion" : "tenant.privacy.action.requestExport")}</button>
    {complete ? <p role="status">{t(kind === "hold" ? "tenant.privacy.notice.holdCreated" : kind === "delete" ? "tenant.privacy.notice.deleteSubmitted" : "tenant.privacy.notice.exportSubmitted")}</p> : null}
    {recovered ? <p role="status">{t("tenant.privacy.recovery.confirmed")}</p> : null}
    {open ? kind === "hold" ? <PrivacyHoldDialog recoveryScope="synthetic-privacy-owner" recovered={recover} mutationHeaders={headers} close={() => setOpen(false)} complete={finish} />
      : <PrivacyRequestDialog recoveryScope="synthetic-privacy-owner" recovered={recover} requestType={kind === "delete" ? "DELETE" : "EXPORT"} mutationHeaders={headers} close={() => setOpen(false)} complete={finish} /> : null}
  </main>;
}
function Workspace({ locale = "en", kind = "export" }: { locale?: "en" | "ar"; kind?: "hold" | "export" | "delete" }) {
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={1792252800000}>
    <div lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}><Dialog kind={kind} /></div>
  </I18nProvider>;
}
export default {
  title: "Product/Privacy targets", component: Workspace, parameters: { layout: "fullscreen", docs: { description: {
    component: "Real privacy dialogs with synthetic browser-controlled responses. This fixture does not qualify native policy or privacy execution.",
  } } },
} satisfies Meta<typeof Workspace>;
type Story = StoryObj<typeof Workspace>;
export const English: Story = {};
export const Arabic: Story = { args: { locale: "ar" } };
export const HoldEnglish: Story = { args: { kind: "hold" } };
export const HoldArabic: Story = { args: { kind: "hold", locale: "ar" } };
export const DeleteEnglish: Story = { args: { kind: "delete" } };
export const DeleteArabic: Story = { args: { kind: "delete", locale: "ar" } };
