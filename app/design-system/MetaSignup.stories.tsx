import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { I18nProvider } from "../I18nProvider";
import { MetaSignup } from "../MetaSignup";
import { getMessages } from "../../lib/i18n/messages";
import "../globals.css";
function Workspace({ locale: initialLocale = "en" }: { locale?: "en" | "ar" }) {
  // The locale changes in place so the browser test can prove the session survives it.
  const [locale, setLocale] = useState(initialLocale);
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={1792252800000}><main className="wx-story-section" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}><div className="panel">
    <MetaSignup name="Synthetic line" mutationHeaders={{}} busyChanged={() => {}} created={() => {}} back={() => {}} />
    <button type="button" className="button secondary" onClick={() => setLocale(locale === "en" ? "ar" : "en")}>Synthetic locale change</button>
  </div></main></I18nProvider>;
}
export default { title: "Product/Meta signup", component: Workspace, args: { locale: "en" }, parameters: { layout: "fullscreen", docs: { description: { component: "Actual Meta signup component; browser fixtures are synthetic exploratory UI evidence, never live Meta acceptance." } } } } satisfies Meta<typeof Workspace>;
type Story = StoryObj<typeof Workspace>;
export const English: Story = {};
export const Arabic: Story = { args: { locale: "ar" } };
