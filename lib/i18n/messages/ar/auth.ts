import type { DictionaryFor } from "../../translate.ts";
import type { englishAuthMessages } from "../en/auth.ts";

export const arabicAuthMessages = {
  "auth.signIn.title": "تسجيل الدخول إلى WasalX",
  "auth.signIn.action": "تسجيل الدخول",
  "auth.signOut.action": "تسجيل الخروج",
  "auth.error.metadataTitle": "خطأ في تسجيل الدخول",
  "auth.error.title": "تعذر إكمال تسجيل الدخول",
  "auth.error.expiredTitle": "انتهت صلاحية تسجيل دخولك",
  "auth.error.invalidState": "ما قدرنا نتحقّق من تسجيل دخولك. حاول من جديد من نفس المتصفح.",
  "auth.error.default": "تعذر على WasalX إكمال تسجيل الدخول. ربما انتهت صلاحية الطلب أو لا يملك هذا الحساب عضوية نشطة في مساحة عمل.",
  "auth.error.action": "إعادة المحاولة",
  "auth.error.back": "الرجوع إلى WasalX",
  "auth.error.expired": "ابدأ من جديد عشان تدخل مساحة عملك.",
  "auth.error.identity": "تعذر ربط هويتك الموثقة بمساحة العمل هذه.",
  "auth.error.membership": "لم يتم العثور على عضوية نشطة لهذا الحساب في مساحة العمل.",
  "auth.error.unavailable": "تسجيل الدخول غير متاح مؤقتا.",
} as const satisfies DictionaryFor<typeof englishAuthMessages>;
