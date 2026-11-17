"use client";

import { useMemo } from "react";
import { textDirection } from "../../lib/i18n/locales.ts";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";
import styles from "./PlatformBoundary.module.css";
import { useBoundaryPreferences } from "../boundary-preferences.ts";

export default function PlatformError({ reset }: { error: Error; reset: () => void }) {
  const {locale,theme}=useBoundaryPreferences("platform");
  const t = useMemo(() => createTranslator(getMessages(locale)), [locale]);
  return (
    <main className={`theme-${theme} wx-design-system ${styles.recoveryPage}`} data-boundary-recovery dir={textDirection(locale)} lang={locale}>
      <section role="alert">
        <span className={styles.operatorMark} aria-hidden="true">WX</span>
        <p className={styles.eyebrow}>{t("platform.error.eyebrow")}</p>
        <h1>{t("platform.error.heading")}</h1>
        <p>{t("platform.error.description")}</p>
        <div className={styles.recoveryActions}>
          <button className={styles.primaryButton} onClick={reset}>{t("platform.error.retry")}</button>
          <a className={styles.secondaryButton} href="/platform/auth/login?return_to=/platform">
            {t("platform.error.signInAgain")}
          </a>
        </div>
      </section>
    </main>
  );
}
