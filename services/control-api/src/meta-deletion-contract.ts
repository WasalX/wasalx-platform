import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type MetaDeletionReviewState = "NEEDS_INFORMATION" | "HELD" | "REFUSED";
export type MetaDeletionReceiptState = "SCOPE_REVIEW_REQUIRED" | MetaDeletionReviewState;
export const metaDeletionReviewReasons = ["SCOPE_EVIDENCE_REQUIRED", "OUTCOME_UNRESOLVED", "LAWFUL_RETENTION"] as const;
export type MetaDeletionReviewReason = typeof metaDeletionReviewReasons[number];
export class MetaDeletionContractError extends Error {
  constructor() { super("Deletion callback or review is invalid"); this.name = "MetaDeletionContractError"; }
}

// user_id belongs to the human Facebook app-scoped namespace. It is never a
// BISU, WasalX member, tenant, portfolio, WABA or Messaging-account grant.
export function verifyMetaDeletionRequest(value: unknown, appId: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof value !== "string" || value.length > 8192 || !/^[0-9]+$/u.test(appId) || Buffer.byteLength(secret,"utf8") < 16) throw new MetaDeletionContractError();
  const parts = value.split(".");
  if (parts.length !== 2) throw new MetaDeletionContractError();
  const signature = decode(parts[0], 32);
  const expected = createHmac("sha256", secret).update(parts[1], "ascii").digest();
  if (signature.length !== 32 || !timingSafeEqual(signature, expected)) throw new MetaDeletionContractError();
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(parts[1], 4096))); }
  catch { throw new MetaDeletionContractError(); }
  if (!record(payload) || payload.algorithm !== "HMAC-SHA256" || typeof payload.user_id !== "string" || !/^[0-9]{1,32}$/u.test(payload.user_id)) throw new MetaDeletionContractError();
  // issued_at is required by our explicit local replay-age policy. This is not
  // a claim that Meta specifies a universal callback TTL.
  if (!Number.isSafeInteger(payload.issued_at) || Number(payload.issued_at) <= 0 || Number(payload.issued_at) > nowSeconds + 300) throw new MetaDeletionContractError();
  if (payload.expires !== undefined && (!Number.isSafeInteger(payload.expires) || Number(payload.expires) < 0)) throw new MetaDeletionContractError();
  return {
    appId, namespace: "FACEBOOK_ASID" as const,
    subjectDigest: createHmac("sha256", secret).update(`wasalx:meta-deletion:facebook-asid:v1:${appId}:${payload.user_id}`).digest("hex"),
    payloadSha256: createHash("sha256").update(parts[1], "ascii").digest("hex"),
    verificationKeyFingerprint: createHmac("sha256",secret).update("wasalx:meta-deletion:verification-key:v1").digest("hex"),
    issuedAt: Number(payload.issued_at),
    expires: payload.expires === undefined ? undefined : Number(payload.expires),
  };
}

export function parseMetaDeletionForm(body: unknown) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 8192) throw new MetaDeletionContractError();
  const fields = new URLSearchParams(body);
  if ([...fields.keys()].some(key => key !== "signed_request") || fields.getAll("signed_request").length !== 1) throw new MetaDeletionContractError();
  return fields.get("signed_request")!;
}

export function parseMetaDeletionReview(body: unknown) {
  if (!record(body) || Object.keys(body).some(key => !["expectedVersion", "state", "reason", "evidenceSha256"].includes(key)) || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) throw new MetaDeletionContractError();
  const permitted = (body.state === "NEEDS_INFORMATION" && body.reason === "SCOPE_EVIDENCE_REQUIRED") ||
    (body.state === "HELD" && body.reason === "OUTCOME_UNRESOLVED") ||
    (body.state === "REFUSED" && body.reason === "LAWFUL_RETENTION");
  if (!permitted || typeof body.evidenceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(body.evidenceSha256)) throw new MetaDeletionContractError();
  return { expectedVersion: Number(body.expectedVersion), state: body.state as MetaDeletionReviewState, reason: body.reason as MetaDeletionReviewReason, evidenceSha256: body.evidenceSha256 };
}

export function metaDeletionLocator(value: unknown) {
  if (typeof value !== "string" || !/^[A-Fa-f0-9]{64}$/u.test(value)) throw new MetaDeletionContractError();
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function decode(value: string, maxBytes: number) {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new MetaDeletionContractError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maxBytes || decoded.toString("base64url") !== value) throw new MetaDeletionContractError();
  return decoded;
}
