import type { Metadata } from "next";
import { getMessages } from "../../../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../../../lib/i18n/request-locale.ts";
import { createTranslator } from "../../../lib/i18n/translate.ts";
import { InvitationAcceptance, type InvitationAcceptanceCopy } from "./InvitationAcceptance";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const translate = createTranslator(getMessages(locale));
  return {
    title: translate("invitation.accept.title"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function InvitationAcceptancePage() {
  const locale = await getRequestLocale();
  const translate = createTranslator(getMessages(locale));
  const copy: InvitationAcceptanceCopy = {
    brand: translate("common.brand.name"),
    header: { home: translate("marketing.navigation.homeAria"), navigation: translate("marketing.navigation.primary"), product: translate("marketing.navigation.product"), signIn: translate("common.actions.signIn"), language: translate("common.locale.label"), languageError: translate("common.errors.generic") },
    preparingTitle: translate("invitation.accept.preparing"),
    preparingDetail: translate("invitation.accept.preparingDetail"),
    invalidTitle: translate("invitation.accept.invalid"),
    invalidDetail: translate("invitation.accept.invalidDetail"),
    unavailableTitle: translate("invitation.accept.unavailable"),
    unavailableDetail: translate("invitation.accept.unavailableDetail"),
    verifying: translate("invitation.accept.verifying"),
    retry: translate("invitation.accept.retry"),
    signInInstead: translate("invitation.accept.signInInstead"),
    securityNote: translate("invitation.accept.securityNote"),
  };
  return <InvitationAcceptance locale={locale} copy={copy} />;
}
