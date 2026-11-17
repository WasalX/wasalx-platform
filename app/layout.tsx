import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import localFont from "next/font/local";
import { BoundaryPreferenceSeed, type BoundaryTheme } from "./boundary-preferences.ts";
import { textDirection } from "../lib/i18n/locales.ts";
import { getMessages } from "../lib/i18n/messages/index.ts";
import { getRequestLocale } from "../lib/i18n/request-locale.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import "./design-system/tokens.css";
import "./design-system/primitives.css";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export async function generateMetadata(): Promise<Metadata> {
  const [origin, locale] = await Promise.all([requestOrigin(), getRequestLocale()]);
  const translate = createTranslator(getMessages(locale));
  return {
    metadataBase: new URL(origin),
    title: {
      default: translate("common.metadata.defaultTitle"),
      template: translate("common.metadata.titleTemplate"),
    },
    description: translate("common.metadata.description"),
    icons: { icon: "/favicon.svg?v=wx-1" },
    openGraph: {
      title: translate("common.metadata.defaultTitle"),
      description: translate("common.metadata.openGraphDescription"),
      type: "website",
    },
    twitter: { card: "summary" },
  };
}

async function requestOrigin() {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host")?.trim();
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const localHost = host?.startsWith("localhost") || host?.startsWith("127.0.0.1");
  const protocol = localHost && forwardedProtocol !== "https" ? "http" : "https";
  if (!host || /[\s/@\\]/u.test(host)) return "https://wasalx.invalid";
  try {
    const value = new URL(`${protocol}://${host}`);
    return value.origin;
  } catch {
    return "https://wasalx.invalid";
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [locale,cookieStore] = await Promise.all([getRequestLocale(),cookies()]);
  const tenantTheme=boundaryTheme(cookieStore.get("__Host-wasalx_theme")?.value,cookieStore.get("wasalx_theme")?.value);
  const platformTheme=boundaryTheme(cookieStore.get("__Host-wasalx_platform_theme")?.value,cookieStore.get("wasalx_platform_theme")?.value);
  return (
    <html lang={locale} dir={textDirection(locale)}>
      <body
        data-design-contract="live-operations-relay-d79147a1"
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <BoundaryPreferenceSeed value={{locale,tenantTheme,platformTheme}}>{children}</BoundaryPreferenceSeed>
      </body>
    </html>
  );
}

function boundaryTheme(...values:Array<string|undefined>):BoundaryTheme{
  return values.find((value):value is BoundaryTheme=>value==="dark"||value==="light")??"dark";
}
