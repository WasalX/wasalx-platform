import type { Metadata } from "next";
import Link from "next/link";
import { getMessages, type MessageKey } from "../../../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../../../lib/i18n/request-locale.ts";
import { createTranslator } from "../../../lib/i18n/translate.ts";
import styles from "../../public-access.module.css";
import { MarketingIcon } from "../../MarketingIcon";
import { InvitationShell } from "../../invitations/InvitationShell";

const authenticationErrorDetails={invalid_callback:"auth.error.expired",invalid_state:"auth.error.invalidState",authentication_failed:"auth.error.default",expired:"auth.error.expired",identity:"auth.error.identity",membership:"auth.error.membership",unavailable:"auth.error.unavailable"} as const satisfies Record<string,MessageKey>;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const translate = createTranslator(getMessages(locale));
  return {
    title: translate("auth.error.metadataTitle"),
    robots: { index: false, follow: false },
  };
}

export default async function AuthenticationErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const [{ reason }, locale] = await Promise.all([searchParams, getRequestLocale()]);
  const translate = createTranslator(getMessages(locale));
  const detail=translate(reason&&Object.hasOwn(authenticationErrorDetails,reason)?authenticationErrorDetails[reason as keyof typeof authenticationErrorDetails]:"auth.error.default");
  return (
    <InvitationShell className={styles.page} locale={locale} header={{ home: translate("marketing.navigation.homeAria"), navigation: translate("marketing.navigation.primary"), product: translate("marketing.navigation.product"), signIn: translate("common.actions.signIn"), language: translate("common.locale.label"), languageError: translate("common.errors.generic") }}>
      <section className={styles.panel}>
        <div aria-hidden="true" className={styles.icon} data-tone="danger"><MarketingIcon name="alert"/></div>
        <h1>{translate(reason === "expired" || reason === "invalid_callback" ? "auth.error.expiredTitle" : "auth.error.title")}</h1>
        <p>{detail}</p>
        <a className="wx-button wx-button-primary" href={reason === "membership" || reason === "identity" ? "/auth/login?prompt=login&return_to=/app" : "/auth/login?return_to=/app"}>
          {translate("auth.error.action")}
        </a>
        <Link className={styles.back} href="/">{translate("auth.error.back")}</Link>
      </section>
    </InvitationShell>
  );
}
