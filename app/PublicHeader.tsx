import type { Locale } from "../lib/i18n/locales.ts";
import Link from "next/link";
import { LocaleSwitcher } from "./LocaleSwitcher";
import "./public-header.css";

export type PublicHeaderCopy = { home: string; navigation: string; product: string; signIn: string; language: string; languageError: string };

export function PublicHeader({ locale, copy }: { locale: Locale; copy: PublicHeaderCopy }) {
  return <header className="public-header">
    <Link className="public-wordmark" href="/" aria-label={copy.home} dir="ltr">Wasal<span>X</span></Link>
    <nav aria-label={copy.navigation}><Link href="/#product">{copy.product}</Link><a href="/auth/login?return_to=/app">{copy.signIn}</a></nav>
    <LocaleSwitcher locale={locale} label={copy.language} errorMessage={copy.languageError}/>
  </header>;
}
