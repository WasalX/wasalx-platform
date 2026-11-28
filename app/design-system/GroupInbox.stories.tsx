import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { getMessages } from "../../lib/i18n/messages";
import { I18nProvider } from "../I18nProvider";
import { InboxWorkspace } from "../InboxWorkspace";
import "../globals.css";

const headers = { "content-type": "application/json" };
function Workspace({ locale = "en", canWrite = true, lifecycle = false }: { locale?: "en" | "ar"; canWrite?: boolean; lifecycle?: boolean }) {
  const [mode, setMode] = useState<"groups" | "tickets">("groups");
  const [group, setGroup] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mounted, setMounted] = useState(true), [sourceNavigations, setSourceNavigations] = useState(0);
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={1792252800000}>
    <div className="wx-story-section" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
      {lifecycle ? <><button type="button" data-source-harness="toggle" onClick={() => setMounted(value => !value)}>Toggle inbox preview</button>
        <output data-source-harness="navigation">{sourceNavigations}</output></> : null}
      {mounted ? <InboxWorkspace mode={mode} selectedGroup={group} selectedMessage={message} selectedTicket={ticket}
        selectGroup={(id, source) => { if (source) setSourceNavigations(value => value + 1); setGroup(id); setMessage(source ?? null); setMode("groups"); }} selectTicket={number => { setTicket(number); setMode("tickets"); }} selectMode={setMode}
        mutationHeaders={headers} canWrite={canWrite} scope="storybook:group-ui:access-v1"
        recoveryScope="storybook:group-ui:synthetic-operator" /> : <p data-source-harness="outside">Outside inbox preview</p>}
    </div>
  </I18nProvider>;
}

export default {
  title: "Product/Group inbox",
  component: Workspace,
  args: { locale: "en" },
  parameters: { layout: "fullscreen", docs: { description: {
    component: "Actual WasalX Groups/Tickets components. Browser tests intercept requests with synthetic data; these stories do not qualify backend permissions, provider delivery or real microphone hardware.",
  } } },
} satisfies Meta<typeof Workspace>;
type Story = StoryObj<typeof Workspace>;
export const English: Story = {};
export const Arabic: Story = { args: { locale: "ar" } };
export const ReadOnly: Story = { args: { canWrite: false } };

export const SourceLifecycleEnglish: Story = { args: { lifecycle: true } };
export const SourceLifecycleArabic: Story = { args: { lifecycle: true, locale: "ar" } };
