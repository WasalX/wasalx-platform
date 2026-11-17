/** Finite form preflight only; the backend still enforces current authority and the full review contract. */
export function validMetaRoutingAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,32}$/u.test(value);
}

export function validMetaRoutingReviewEvidence(observedAt: number, evidenceSha256: string, evidenceReference: string, now = Date.now()): boolean {
  return Number.isFinite(observedAt) && observedAt > 0 && observedAt <= now
    && /^[0-9a-f]{64}$/u.test(evidenceSha256)
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(evidenceReference);
}
