import type { Metadata } from "next";
import { getMessages, type MessageKey } from "../../../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../../../lib/i18n/request-locale.ts";
import { createTranslator } from "../../../lib/i18n/translate.ts";
import { InvitationShell } from "../InvitationShell";
import styles from "../../public-access.module.css";
import { MarketingIcon } from "../../MarketingIcon";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const translate = createTranslator(getMessages(locale));
  return {
    title: translate("invitation.result.metadataTitle"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

type InvitationResultContent = {
  icon: "clock" | "person" | "email" | "groups" | "alert";
  tone: "success" | "warning" | "danger";
  title: MessageKey;
  detail: MessageKey;
  action: MessageKey;
  href: string;
};

const messages: Record<string, InvitationResultContent> = {
  expired_or_used: {
    icon: "clock",
    tone: "warning",
    title: "invitation.result.expired.title",
    detail: "invitation.result.expired.detail",
    action: "invitation.result.expired.action",
    href: "/auth/login?return_to=/app",
  },
  identity_mismatch: {
    icon: "person",
    tone: "danger",
    title: "invitation.result.mismatch.title",
    detail: "invitation.result.mismatch.detail",
    action: "invitation.result.mismatch.action",
    href: "/",
  },
  identity_unverified: {
    icon: "email",
    tone: "danger",
    title: "invitation.result.unverified.title",
    detail: "invitation.result.unverified.detail",
    action: "invitation.result.unverified.action",
    href: "/",
  },
  membership_conflict: {
    icon: "groups",
    tone: "danger",
    title: "invitation.result.conflict.title",
    detail: "invitation.result.conflict.detail",
    action: "invitation.result.conflict.action",
    href: "/auth/login?return_to=/app",
  },
  authentication_failed: {
    icon: "alert",
    tone: "warning",
    title: "invitation.result.failed.title",
    detail: "invitation.result.failed.detail",
    action: "invitation.result.failed.action",
    href: "/",
  },
} as const;

export default async function InvitationResultPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const [{ state }, locale] = await Promise.all([searchParams, getRequestLocale()]);
  const translate = createTranslator(getMessages(locale));
  const content = state && Object.hasOwn(messages, state) ? messages[state] : messages.authentication_failed;
  return (
    <InvitationShell className={styles.page} locale={locale} header={{ home: translate("marketing.navigation.homeAria"), navigation: translate("marketing.navigation.primary"), product: translate("marketing.navigation.product"), signIn: translate("common.actions.signIn"), language: translate("common.locale.label"), languageError: translate("common.errors.generic") }}>
      <section className={styles.panel}>
        <div className={styles.icon} data-tone={content.tone} aria-hidden="true"><MarketingIcon name={content.icon}/></div>
        <h1>{translate(content.title)}</h1>
        <p>{translate(content.detail)}</p>
        <a className="wx-button wx-button-primary" href={content.href}>{translate(content.action)}</a>
        <small>{translate("invitation.result.singleUse")}</small>
      </section>
    </InvitationShell>
  );
}
