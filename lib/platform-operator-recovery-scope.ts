// Server-page/BFF current-session fence. This digest is not an authorization grant.
export async function platformOperatorRecoveryScope(issuer: string, subject: string) {
  if (!issuer || !subject) throw Error("Platform operator identity is unavailable");
  const bytes = new TextEncoder().encode(JSON.stringify(["wasalx-platform-review-recovery-v1", issuer, subject]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
