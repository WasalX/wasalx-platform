"use client";

import { useMemo } from "react";
import { textDirection } from "../../lib/i18n/locales.ts";
import { getBoundaryMessages } from "../../lib/i18n/messages/boundary.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";
import styles from "../platform/PlatformBoundary.module.css";
import { useBoundaryPreferences } from "../boundary-preferences.ts";

export default function TenantError({ reset }: { error: Error; reset: () => void }) {
  const {locale,theme}=useBoundaryPreferences("tenant");
  const t = useMemo(() => createTranslator(getBoundaryMessages(locale)), [locale]);
  return (
    <main className={`theme-${theme} wx-design-system ${styles.recoveryPage}`} data-boundary-recovery dir={textDirection(locale)} lang={locale}>
      <section role="alert">
        <span aria-hidden="true" className={styles.operatorMark}>WX</span>
        <h1>{t("tenant.boundary.error.heading")}</h1>
        <p>{t("tenant.boundary.error.description")}</p>
        <div className={styles.recoveryActions}>
          <button className={styles.primaryButton} onClick={reset}>{t("common.actions.retry")}</button>
          <a className={styles.secondaryButton} href="/auth/login?return_to=/app">
            {t("tenant.session.signIn")}
          </a>
        </div>
      </section>
    </main>
  );
}
