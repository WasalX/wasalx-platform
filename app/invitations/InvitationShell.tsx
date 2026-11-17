import type { ReactNode } from "react";
import type { Locale } from "../../lib/i18n/locales.ts";
import { PublicHeader, type PublicHeaderCopy } from "../PublicHeader";

export function InvitationShell({ children, className, locale, header }: { children: ReactNode; className: string; locale: Locale; header: PublicHeaderCopy }) {
  return <div className="theme-light wx-design-system public-access-shell"><PublicHeader locale={locale} copy={header}/><main className={className}>{children}</main></div>;
}
