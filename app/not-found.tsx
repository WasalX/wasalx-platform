import type { Metadata } from "next";
import Link from "next/link";
import { getMessages } from "../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../lib/i18n/request-locale.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import styles from "./auth/error/page.module.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = createTranslator(getMessages(locale));
  return { title: t("common.notFound.title"), robots: { index: false, follow: false } };
}

export default async function NotFoundPage() {
  const locale = await getRequestLocale();
  const t = createTranslator(getMessages(locale));
  return (
    <main className={`theme-dark wx-design-system ${styles.page}`}>
      <section className={styles.panel}>
        <div aria-hidden="true" className={styles.icon}>?</div>
        <h1>{t("common.notFound.title")}</h1>
        <p>{t("common.notFound.body")}</p>
        <Link className="wx-button wx-button-primary" href="/">
          {t("common.actions.goHome")}
        </Link>
      </section>
    </main>
  );
}
