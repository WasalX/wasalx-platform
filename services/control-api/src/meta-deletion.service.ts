import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DatabaseService } from "./database.service.js";
import { WebhookSecretService } from "./webhook-secret.service.js";
import { MetaDeletionContractError, verifyMetaDeletionRequest } from "./meta-deletion-contract.js";

@Injectable()
export class MetaDeletionService {
  constructor(private readonly database: DatabaseService, private readonly secrets: WebhookSecretService) {}
  async receive(signedRequest: unknown) {
    const config = metaDeletionConfiguration();
    const secret = await this.secrets.resolveHmac(config.secretReference, { kind: "exact", expectedReference: config.secretReference });
    let input: ReturnType<typeof verifyMetaDeletionRequest>;
    try { input = verifyMetaDeletionRequest(signedRequest, config.appId, secret); }
    catch (error) { if (error instanceof MetaDeletionContractError) throw new BadRequestException("Deletion callback is invalid"); throw error; }
    let receipt:{locator:string};
    try {receipt=await this.database.receiveMetaDeletionReceipt({ ...input, locator: Buffer.from(randomBytes(32)).toString("hex"), maxAgeSeconds: config.maxAgeSeconds, retentionDays: config.retentionDays });}
    catch(error){if(error&&typeof error==="object"&&"code" in error&&error.code==="22023")throw new BadRequestException("Deletion callback is outside the local admission window");throw error;}
    // Locator is intentionally recoverable for lost-response idempotency. It
    // reveals only generic status and never grants data/deletion authority.
    return { url: `${config.statusOrigin}/privacy/meta-deletion#${receipt.locator}`, confirmation_code: receipt.locator };
  }
  async status(locator: string) { try{return await this.database.metaDeletionReceiptStatus(locator);}catch(error){if(error&&typeof error==="object"&&"code" in error&&error.code==="54000")throw new HttpException("Status lookup limit reached",429);throw error;} }
}

export function metaDeletionConfiguration() {
  const appId = process.env.META_APP_ID ?? "";
  const secretReference = process.env.META_APP_SECRET_REFERENCE ?? "";
  const rawOrigin = process.env.META_DELETION_STATUS_ORIGIN ?? "";
  const maxAgeSeconds = Number(process.env.META_DELETION_MAX_REQUEST_AGE_SECONDS);
  const retentionDays = Number(process.env.META_DELETION_RECEIPT_RETENTION_DAYS);
  let origin: URL;
  let help:URL;
  try { origin = new URL(rawOrigin);help=new URL(process.env.META_DELETION_HELP_URL??""); } catch { throw new ServiceUnavailableException("Deletion callback is not configured"); }
  if (!/^[0-9]+$/u.test(appId) || !secretReference.startsWith("secret://") || origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || help.protocol!=="https:"||help.username||help.password||help.search||help.hash ||
      !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 300 || maxAgeSeconds > 2592000 || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 || retentionDays * 86400 < maxAgeSeconds + 301) {
    throw new ServiceUnavailableException("Deletion callback is not configured");
  }
  return { appId, secretReference, statusOrigin: origin.origin, maxAgeSeconds, retentionDays };
}

// Optional for new refusal only. Receipt/replay admission never depends on it.
export function metaDeletionRefusalPolicyUrl(): string | undefined {
  const value=process.env.META_DELETION_REFUSAL_POLICY_URL;
  if(!value||value.length>2048)return undefined;
  try{const url=new URL(value);if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)return undefined;return url.href;}catch{return undefined;}
}
