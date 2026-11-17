import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardData } from "../../lib/data";
import { isControlPlaneBackend } from "../../lib/backend";
import { PortalSessionError } from "../../lib/portal-session";
import { portalFixturePersona } from "../../lib/fixture-role";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../../lib/i18n/request-locale.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";
import { tenantViewTitle } from "../../lib/tenant-view-titles.ts";
import { getChatGPTUser } from "../chatgpt-auth";
import { I18nProvider } from "../I18nProvider";
import { WasalXApp } from "../WasalXApp";

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: PageSearchParams }): Promise<Metadata> {
  const [locale, query] = await Promise.all([getRequestLocale(), searchParams]);
  const translate = createTranslator(getMessages(locale));
  const requested = Array.isArray(query.view) ? query.view[0] : query.view;
  return { title: translate(tenantViewTitle(requested)[0]) };
}

export default async function TenantApplicationPage({ searchParams }: { searchParams: PageSearchParams }) {
  const [locale, query] = await Promise.all([getRequestLocale(), searchParams]);
  const initialView = Array.isArray(query.view) ? query.view[0] : query.view;
  const i18n = { locale, messages: getMessages(locale), renderedAt: new Date().getTime() };
  if (isControlPlaneBackend()) {
    const { dashboard, session } = await loadControlPlanePage(appReturnPath(query));
    if (!dashboard || !session) {
      const t=createTranslator(i18n.messages);
      return <main className="portal-session-expired theme-dark" lang={locale} dir={locale==="ar"?"rtl":"ltr"}><section role="alert"><h1>{t("tenant.accessDenied.heading")}</h1><p>{t("tenant.accessDenied.description")}</p><a className="button primary" href="/auth/login?prompt=login&return_to=/app">{t("tenant.session.signIn")}</a></section></main>;
    }
    return <I18nProvider {...i18n}><WasalXApp initialData={dashboard} initialView={initialView} user={{ userId: session.userId, displayName: session.displayName, email: session.email, fullName: session.displayName, csrfToken: session.csrfToken, role: session.role }} /></I18nProvider>;
  }
  const [dashboard, authenticatedUser] = await Promise.all([getDashboardData(), getChatGPTUser()]);
  const user = authenticatedUser ?? { userId: "local-preview", displayName: "Maya Al-Salem", email: "maya@northstar.example", fullName: "Maya Al-Salem" };
  const fixturePersona = portalFixturePersona();
  return <I18nProvider {...i18n}><WasalXApp initialData={dashboard} initialView={initialView} user={fixturePersona ?? { ...user, role: String(dashboard.tenant.role ?? "") }} /></I18nProvider>;
}

async function loadControlPlanePage(returnTo: string) {
  try {
    const [{ currentPortalSession }, dashboard] = await Promise.all([import("../../lib/control-plane-data"), getDashboardData()]);
    return { dashboard, session: await currentPortalSession() };
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status===403) return {dashboard:null,session:null};
    if ((error instanceof PortalSessionError && error.status < 500) || (error instanceof Error && "status" in error && (error as { status?: number }).status === 401)) redirect(`/auth/login?return_to=${returnTo === "/app" ? "/app" : encodeURIComponent(returnTo)}`);
    throw error;
  }
}

function appReturnPath(query: Record<string, string | string[] | undefined>) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) parameters.append(key, entry);
  }
  return parameters.size ? `/app?${parameters}` : "/app";
}
