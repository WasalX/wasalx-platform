import type { Metadata } from "next";
import Link from "next/link";
import { textDirection } from "../../../../lib/i18n/locales.ts";
import { getMessages } from "../../../../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../../../../lib/i18n/request-locale.ts";
import { createTranslator } from "../../../../lib/i18n/translate.ts";
import styles from "../../PlatformBoundary.module.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return { title: createTranslator(getMessages(locale))("platform.auth.title") };
}

export default async function PlatformAuthenticationErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const [{ reason }, locale] = await Promise.all([searchParams, getRequestLocale()]);
  const t = createTranslator(getMessages(locale));
  const detail =
    reason === "invalid_state"
      ? t("platform.auth.invalidState")
      : t("platform.auth.verificationFailed");
  return (
    <main className={`theme-dark wx-design-system ${styles.authPage}`} dir={textDirection(locale)} lang={locale}>
      <section className={styles.authPanel}>
        <span aria-hidden="true" className={styles.operatorMark}>WX</span>
        <p className={styles.eyebrow}>{t("platform.auth.eyebrow")}</p>
        <h1>{t("platform.auth.failed")}</h1>
        <p>{detail}</p>
        <Link className="wx-button wx-button-primary" href="/platform/auth/login">
          {t("platform.auth.authenticateAgain")}
        </Link>
      </section>
    </main>
  );
}
