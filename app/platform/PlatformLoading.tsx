import { textDirection } from "../../lib/i18n/locales.ts";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import type { Locale } from "../../lib/i18n/locales.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";
import styles from "./PlatformBoundary.module.css";

export function PlatformLoading({ locale }: { locale: Locale }) {
  const t = createTranslator(getMessages(locale));
  return (
    <main
      aria-busy="true"
      aria-label={t("platform.loading")}
      className={`theme-dark wx-design-system ${styles.loadingPage}`}
      dir={textDirection(locale)}
      lang={locale}
    >
      <section>
        <span className={styles.operatorMark}>WX</span>
        <p className={styles.eyebrow}>{t("platform.hero.eyebrow")}</p>
        <h1>{t("platform.loading.state")}</h1>
        <div aria-hidden="true" className={styles.loadingGrid}>
          <i /><i /><i /><i />
        </div>
      </section>
    </main>
  );
}
