import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { getMessages } from "../../lib/i18n/messages";
import { I18nProvider } from "../I18nProvider";
import { Inbox } from "../Inbox";

const headers = { "content-type": "application/json" };
function Workspace({ locale = "en" }: { locale?: "en" | "ar" }) {
  const [ticket, setTicket] = useState<string | null>(null);
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={1792252800000}>
    <div className="wx-story-section" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
      <Inbox mutationHeaders={headers} targetTicketNumber={ticket} selectTicket={setTicket}
        canWrite scope="storybook:synthetic-operator" />
    </div>
  </I18nProvider>;
}

export default {
  title: "Product/Inbox",
  component: Workspace,
  args: { locale: "en" },
  parameters: { layout: "fullscreen", docs: { description: {
    component: "WasalX conversation workspace. Without a connected API it shows recovery. Browser interaction tests provide synthetic requests; these are not provider or backend acceptance.",
  } } },
} satisfies Meta<typeof Workspace>;
type Story = StoryObj<typeof Workspace>;
export const English: Story = {};
export const Arabic: Story = { args: { locale: "ar" } };
