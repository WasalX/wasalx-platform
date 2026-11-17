import type { Metadata } from "next";
import { getRequestLocale } from "../../../lib/i18n/request-locale.ts";
import { getMessages } from "../../../lib/i18n/messages/index.ts";
import { I18nProvider } from "../../I18nProvider";
import { MetaDeletionStatus } from "./MetaDeletionStatus";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function Page() {
  const locale = await getRequestLocale();
  let helpUrl:string|undefined;
  try{const url=new URL(process.env.META_DELETION_HELP_URL??"");if(url.protocol==="https:"&&!url.username&&!url.password&&!url.search&&!url.hash)helpUrl=url.href;}catch{/* Missing policy configuration is never replaced with an invented support destination. */}
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={new Date().getTime()}><MetaDeletionStatus helpUrl={helpUrl} /></I18nProvider>;
}
