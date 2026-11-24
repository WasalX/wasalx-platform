import { parseMetaDirectIdentity } from "./meta-direct-identity.js";

export function parseMetaMarketingPreferences(value: Record<string, unknown>, now: number, rejectItem?: () => void) {
  if (value.messaging_product !== "whatsapp" || !Array.isArray(value.user_preferences)
    || value.user_preferences.length === 0 || value.user_preferences.length > 1000) {
    throw new Error("Invalid WhatsApp marketing preferences");
  }
  const currentSeconds = Math.floor(now / 1000);
  const preferences = value.user_preferences.flatMap((item: unknown) => {
    try {
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid marketing preference item");
      const row = item as Record<string, unknown>;
      const seconds = typeof row.timestamp === "string" && /^\d{1,12}$/u.test(row.timestamp) ? Number(row.timestamp) : row.timestamp;
      if (row.category !== "marketing_messages" || (row.value !== "stop" && row.value !== "resume")
        || typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0
        || (row.value === "resume" && seconds < currentSeconds - 7 * 86400) || seconds > currentSeconds + 300) {
        throw new Error("Invalid marketing preference item");
      }
      // Preferences apply to the row's user. A parent BSUID is shared.
      const { identity } = parseMetaDirectIdentity({ from: row.wa_id, from_user_id: row.user_id });
      return [{
        phone: identity.phone ?? null,
        bsuid: identity.bsuid ?? null,
        optedOut: row.value === "stop",
        observedAt: new Date(seconds * 1000).toISOString(),
      }];
    } catch {
      rejectItem?.();
      return [];
    }
  });
  if (!preferences.length) throw new Error("Invalid WhatsApp marketing preferences");
  return preferences;
}
