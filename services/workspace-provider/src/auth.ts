import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ProviderError } from "./types.js";

export class FileBearerAuthenticator {
  constructor(private readonly tokenFile: string) {}

  async authenticate(authorization: string | undefined) {
    if (!authorization?.startsWith("Bearer ")) denied();
    const presented = authorization.slice(7);
    let expected: string;
    try { expected = (await readFile(this.tokenFile, "utf8")).trim(); }
    catch { throw new ProviderError(503, "AUTHORITY_UNAVAILABLE", "Provider authentication is temporarily unavailable.", true); }
    if (!valid(expected) || !valid(presented)) denied();
    const left = createHash("sha256").update(presented).digest();
    const right = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(left, right)) denied();
  }
}

function valid(value: string) {
  return value.length >= 32 && value.length <= 16_384 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function denied(): never {
  throw new ProviderError(401, "AUTHENTICATION_REQUIRED", "Provider authentication is required.");
}
