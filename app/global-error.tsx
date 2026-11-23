"use client";

import {useMemo} from "react";
import {textDirection} from "../lib/i18n/locales.ts";
import {getBoundaryMessages,type BoundaryMessageKey} from "../lib/i18n/messages/boundary.ts";
import {createTranslator} from "../lib/i18n/translate.ts";
import {useBoundaryPreferences} from "./boundary-preferences.ts";
import styles from "./platform/PlatformBoundary.module.css";

const neutralEnglish=createTranslator(getBoundaryMessages("en"));
const neutralArabic=createTranslator(getBoundaryMessages("ar"));

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const {surface,locale,theme}=useBoundaryPreferences(undefined,true);
  const activeLocale=locale??"en";
  const t=useMemo(()=>createTranslator(getBoundaryMessages(activeLocale)),[activeLocale]);
  const recovery:{heading:BoundaryMessageKey;description:BoundaryMessageKey;action:BoundaryMessageKey;href:string}=surface==="platform"
    ?{heading:"platform.error.heading",description:"platform.error.description",action:"platform.error.signInAgain",href:"/platform/auth/login?return_to=/platform"}
    :surface==="tenant"
      ?{heading:"tenant.boundary.error.heading",description:"tenant.boundary.error.description",action:"tenant.session.signIn",href:"/auth/login?return_to=/app"}
      :{heading:"common.boundary.error.heading",description:"common.boundary.error.description",action:"common.actions.signIn",href:"/auth/login?return_to=/app"};
  return (
    <html lang={locale??"en"} dir={locale?textDirection(locale):"ltr"}>
      <body className={`theme-${theme} wx-design-system`} data-boundary-recovery data-global-recovery="true">
        <main className={styles.recoveryPage}>
          <section role="alert">
            <span aria-hidden="true" className={styles.operatorMark}>WX</span>
            {locale?<><h1>{t(recovery.heading)}</h1><p>{t(recovery.description)}</p></>:<>
              <h1><span lang="en" dir="ltr">{neutralEnglish("common.boundary.error.heading")}</span><br/><span lang="ar" dir="rtl">{neutralArabic("common.boundary.error.heading")}</span></h1>
              <p><span lang="en" dir="ltr">{neutralEnglish("common.boundary.error.description")}</span><br/><span lang="ar" dir="rtl">{neutralArabic("common.boundary.error.description")}</span></p>
            </>}
            <div className={styles.recoveryActions}>
              <button className={styles.primaryButton} type="button" onClick={reset}>{locale?t("common.actions.retry"):<><span lang="en" dir="ltr">{neutralEnglish("common.actions.retry")}</span> / <span lang="ar" dir="rtl">{neutralArabic("common.actions.retry")}</span></>}</button>
              {locale?<a className={styles.secondaryButton} href={recovery.href}>{t(recovery.action)}</a>:null}
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
