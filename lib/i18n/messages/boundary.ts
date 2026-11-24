import type { Locale } from "../locales.ts";
import type { ProductMessages } from "./index.ts";

// Error boundaries keep their own copy of these strings so they render without the full catalogue chunk.
// tests/i18n-server-surfaces.test.mjs keeps every value equal to the catalogue.
type BoundaryMessages = Pick<ProductMessages,
  | "common.actions.retry"
  | "common.actions.signIn"
  | "common.boundary.error.heading"
  | "common.boundary.error.description"
  | "tenant.boundary.error.heading"
  | "tenant.boundary.error.description"
  | "tenant.session.signIn"
  | "platform.error.eyebrow"
  | "platform.error.heading"
  | "platform.error.description"
  | "platform.error.retry"
  | "platform.error.signInAgain"
>;

export type BoundaryMessageKey = keyof BoundaryMessages;

const englishBoundaryMessages: BoundaryMessages = {
  "common.actions.retry": "Try again",
  "common.actions.signIn": "Sign in",
  "common.boundary.error.heading": "WasalX is temporarily unavailable",
  "common.boundary.error.description": "Nothing was recorded as complete. Try again, or sign in if the problem continues.",
  "tenant.boundary.error.heading": "Workspace temporarily unavailable",
  "tenant.boundary.error.description": "WasalX could not load this workspace. No change was reported as successful. Try again, or sign in again if the issue continues.",
  "tenant.session.signIn": "Sign in again",
  "platform.error.eyebrow": "Platform data unavailable",
  "platform.error.heading": "The platform console could not load.",
  "platform.error.description": "No change was reported as successful. Try again, or sign in again if the problem continues.",
  "platform.error.retry": "Retry",
  "platform.error.signInAgain": "Sign in again",
};

const arabicBoundaryMessages: BoundaryMessages = {
  "common.actions.retry": "إعادة المحاولة",
  "common.actions.signIn": "تسجيل الدخول",
  "common.boundary.error.heading": "WasalX غير متاح مؤقتًا",
  "common.boundary.error.description": "لم يُسجّل أي إجراء على أنه مكتمل. حاول مجددًا، أو سجّل الدخول إذا استمرت المشكلة.",
  "tenant.boundary.error.heading": "مساحة العمل غير متاحة مؤقتًا",
  "tenant.boundary.error.description": "تعذّر على WasalX تحميل مساحة العمل هذه. لم يُسجّل أي تغيير على أنه ناجح. حاول مجددًا، أو سجّل الدخول من جديد إذا استمرت المشكلة.",
  "tenant.session.signIn": "تسجيل الدخول مجددًا",
  "platform.error.eyebrow": "بيانات المنصة غير متاحة",
  "platform.error.heading": "تعذّر تحميل وحدة تحكم المنصة.",
  "platform.error.description": "لم يُسجّل أي تغيير على أنه ناجح. أعد المحاولة، أو سجّل الدخول من جديد إذا استمرت المشكلة.",
  "platform.error.retry": "إعادة المحاولة",
  "platform.error.signInAgain": "تسجيل الدخول مجددًا",
};

export function getBoundaryMessages(locale: Locale): BoundaryMessages {
  return locale === "ar" ? arabicBoundaryMessages : englishBoundaryMessages;
}
