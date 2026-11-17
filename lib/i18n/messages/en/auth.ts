import type { MessageDictionary } from "../../translate.ts";

export const englishAuthMessages = {
  "auth.signIn.title": "Sign in to WasalX",
  "auth.signIn.action": "Sign in",
  "auth.signOut.action": "Sign out",
  "auth.error.metadataTitle": "Sign-in error",
  "auth.error.title": "Sign-in could not be completed",
  "auth.error.expiredTitle": "Your sign-in expired",
  "auth.error.invalidState": "The sign-in state could not be verified. Start a new sign-in from this browser.",
  "auth.error.default": "WasalX could not complete sign-in. The request may have expired, or this account may not have an active workspace membership.",
  "auth.error.action": "Try again",
  "auth.error.back": "Back to WasalX",
  "auth.error.expired": "Your sign-in request expired. Start again.",
  "auth.error.identity": "Your verified identity could not be linked to this workspace.",
  "auth.error.membership": "No active workspace membership was found for this account.",
  "auth.error.unavailable": "Sign-in is temporarily unavailable.",
} as const satisfies MessageDictionary;
