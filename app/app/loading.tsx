import { cookies } from "next/headers";
import { textDirection } from "../../lib/i18n/locales.ts";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../../lib/i18n/request-locale.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";
import styles from "../platform/PlatformBoundary.module.css";

export default async function TenantLoading() {
  const [locale, cookieStore] = await Promise.all([getRequestLocale(), cookies()]);
  const t = createTranslator(getMessages(locale));
  // Match the workspace theme the browser last used so the loading screen does not flash dark for light-mode users.
  const theme = [cookieStore.get("__Host-wasalx_theme")?.value, cookieStore.get("wasalx_theme")?.value].find(value => value === "dark" || value === "light") ?? "dark";
  return (
    <main
      aria-busy="true"
      aria-label={t("tenant.loading.workspace")}
      className={`theme-${theme} wx-design-system ${styles.loadingPage}`}
      dir={textDirection(locale)}
      lang={locale}
    >
      <section>
        <span aria-hidden="true" className={styles.operatorMark}>WX</span>
        <h1>{t("tenant.loading.workspace")}</h1>
        <div aria-hidden="true" className={styles.loadingGrid}>
          <i /><i /><i /><i />
        </div>
      </section>
    </main>
  );
}
