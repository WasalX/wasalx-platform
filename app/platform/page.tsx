import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { isControlPlaneBackend } from "../../lib/backend";
import { getMessages } from "../../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../../lib/i18n/request-locale.ts";
import { createTranslator } from "../../lib/i18n/translate.ts";
import {
  platformSessionCookieName,
  PlatformPortalSessionError,
} from "../../lib/platform-portal-session";
import { loadStoredPlatformSession } from "../../lib/platform-portal-session-store";
import { I18nProvider } from "../I18nProvider";
import { platformOperatorRecoveryScope } from "../../lib/platform-operator-recovery-scope.ts";
import { platformOidcConfiguration } from "../../lib/platform-oidc.ts";
import { PlatformConsole } from "./PlatformConsole";
import { PlatformLoading } from "./PlatformLoading";
import type {
  PlatformOverview,
  TenantOperationsPage,
} from "./platform-types";

export const dynamic = "force-dynamic";
type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const translate = createTranslator(getMessages(locale));
  return {
    title: translate("platform.title"),
    description: translate("platform.metadata.description"),
  };
}

export default async function PlatformPage({ searchParams }: { searchParams: PageSearchParams }) {
  if (!isControlPlaneBackend()) notFound();
  const [locale, query] = await Promise.all([getRequestLocale(), searchParams]);
  const returnTo = platformReturnPath(query);
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(platformSessionCookieName())?.value;
  if (!sessionId) redirect(platformLoginPath(returnTo));
  const session = await loadPlatformSession(sessionId);
  if (!session) redirect(platformLoginPath(returnTo));
  return <Suspense fallback={<PlatformLoading locale={locale} />}>
    <PlatformView locale={locale} returnTo={returnTo} session={session} />
  </Suspense>;
}

async function PlatformView({ locale, returnTo, session }: {
  locale: Awaited<ReturnType<typeof getRequestLocale>>;
  returnTo: string;
  session: Awaited<ReturnType<typeof loadStoredPlatformSession>>;
}) {
  const data = await loadPlatformData(session);
  if (!data) redirect(platformLoginPath(returnTo));
  const { overview, tenants } = data;
  return <I18nProvider locale={locale} messages={getMessages(locale)} renderedAt={new Date(overview.generated_at).getTime()}>
    <PlatformConsole
        initialOverview={overview}
        initialTenants={tenants}
        operator={{
          displayName: session.displayName,
          email: session.email,
          authenticatedAt: session.authenticatedAt,
          expiresAt: session.expiresAt,
          csrfToken: session.csrfToken,
          recoveryScope: await platformOperatorRecoveryScope(platformOidcConfiguration().issuer, session.subject),
        }}
      />
  </I18nProvider>;
}

async function loadPlatformSession(sessionId: string) {
  try {
    return await loadStoredPlatformSession(sessionId);
  } catch (error) {
    if (error instanceof PlatformPortalSessionError) return null;
    throw error;
  }
}

async function loadPlatformData(session: Awaited<ReturnType<typeof loadStoredPlatformSession>>) {
  try {
    const [overview, tenants] = await Promise.all([
      platformFetch<PlatformOverview>(session.accessToken, "operations/overview"),
      platformFetch<TenantOperationsPage>(
        session.accessToken,
        "operations/tenants?limit=50",
      ),
    ]);
    return { overview, tenants };
  } catch (error) {
    if (
      error instanceof PlatformPortalSessionError ||
      (error instanceof Error && "status" in error && error.status === 401)
    ) {
      return null;
    }
    throw error;
  }
}

async function platformFetch<T>(token: string, path: string) {
  const rawBaseUrl = process.env.CONTROL_API_URL;
  if (!rawBaseUrl) throw new Error("CONTROL_API_URL is required");
  const response = await fetch(
    new URL(`/platform/v1/${path}`, ensureTrailingSlash(rawBaseUrl)),
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    const error = new Error("The platform operations API is unavailable") as Error & {
      status: number;
    };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function platformReturnPath(query: Record<string, string | string[] | undefined>) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) parameters.append(key, entry);
  }
  return parameters.size ? `/platform?${parameters}` : "/platform";
}

function platformLoginPath(returnTo: string) {
  return `/platform/auth/login?return_to=${returnTo === "/platform" ? "/platform" : encodeURIComponent(returnTo)}`;
}
