const SECRET_KEY = /(?:access.?key|authorization|credential|database.?url|password|secret|token)/iu;

export function safeError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "CONFIGURATOR_FAILED";
  return { status: "FAILED", code: safeCode(code) };
}

export function assertSecretFree(value: unknown): void {
  walk(value, new Set());
}

function walk(value: unknown, seen: Set<object>) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "password_login_disabled" && typeof entry === "boolean") continue;
    if (SECRET_KEY.test(key)) throw Object.assign(new Error("Unsafe output"), { code: "UNSAFE_OUTPUT" });
    walk(entry, seen);
  }
}

function safeCode(value: string) {
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : "CONFIGURATOR_FAILED";
}
