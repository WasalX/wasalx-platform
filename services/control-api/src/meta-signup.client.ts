import { createHash, randomUUID } from "node:crypto";
import { verifyMetaCredentialMetadata, type MetaCredentialMetadata } from "@wasalx/core/meta-account-relation";
import { metaId, metaSignupGrantCandidates, metaSignupPhone, metaSignupChoiceAdmission, object } from "@wasalx/core/meta-signup";
import { graphBaseUrl, metaGraphRequest, MetaGraphClientError } from "./meta-groups.client.js";
import type { MetaSignupChoice } from "./meta-signup.types.js";

export type SignupConfig = { appId: string; configId: string; graphVersion: string; secretReference: string; origin: string;
  variant?: "STANDARD" | "BUSINESS_APP" };
export type VerifiedSignupChoice = MetaSignupChoice & { businessId: string; wabaId: string; phoneId: string; proofSha256: string;
  lastOnboardedTime?: number };

/** Same customer credential for every discovery edge; no platform-token fallback. */
export class MetaSignupClient {
  private readonly transport;
  constructor(private readonly config: SignupConfig, private readonly token?: string, beforeRequest?: () => Promise<void>) {
    this.transport = { baseUrl: graphBaseUrl(process.env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com"), graphVersion: config.graphVersion, beforeRequest };
  }

  async exchange(code: string, appSecret: string) {
    // Meta specifies GET for exchange; it is a one-use MUTATION, never a retryable read.
    const response = object(await metaGraphRequest(this.transport, "/oauth/access_token", "GET", "mutation", undefined,
      { client_id: this.config.appId, client_secret: appSecret, code }, AbortSignal.timeout(10_000), `${this.config.appId}|${appSecret}`));
    const token = response?.access_token;
    // eslint-disable-next-line no-control-regex -- Reject exact ASCII control/space bytes at the credential boundary.
    if (typeof token !== "string" || token.length < 16 || token.length > 4096 || /[\x00-\x20\x7f]/u.test(token)) throw unavailable(false);
    return token;
  }

  async inspect(appSecret: string): Promise<{ metadata: MetaCredentialMetadata; candidates: ReturnType<typeof metaSignupGrantCandidates> }> {
    const response = await metaGraphRequest(this.transport, "/debug_token", "GET", "read", undefined,
      { input_token: this.token! }, undefined, `${this.config.appId}|${appSecret}`);
    return { metadata: verifyMetaCredentialMetadata(response, { appId: this.config.appId }), candidates: metaSignupGrantCandidates(response) };
  }

  async discover(appSecret: string): Promise<{ metadata: MetaCredentialMetadata; choices: VerifiedSignupChoice[] }> {
    const { metadata, candidates } = await this.inspect(appSecret);
    const signal = AbortSignal.timeout(30_000);
    let accountIds = candidates.accountIds;
    if (!accountIds.length && candidates.userId) {
      accountIds = (await this.list(`/${candidates.userId}/assigned_whatsapp_business_accounts`, "id,name", signal)).map(row => String(row.id));
    }
    if (!accountIds.length) return { metadata, choices: [] };
    // Bound the whole response and never silently truncate a choice set.
    if (accountIds.length > 20) throw unavailable();
    const choices: VerifiedSignupChoice[] = [];
    for (const wabaId of accountIds) {
      const account = object(await this.read(`/${wabaId}`, { fields: "id,name,owner_business{id,name}" }, signal));
      const owner = object(account?.owner_business);
      if (account?.id !== wabaId || !metaId(owner?.id)) throw unavailable();
      const owned = await this.list(`/${owner.id}/owned_whatsapp_business_accounts`, "id", signal);
      if (!owned.some(row => row.id === wabaId)) throw unavailable();
      const phones = await this.list(`/${wabaId}/phone_numbers`, "id,display_phone_number,verified_name,status,code_verification_status,account_mode,host_platform", signal);
      for (const row of phones) {
        if (choices.length >= 100) throw unavailable();
        let variant: Record<string, unknown> | undefined;
        try { variant = object(await this.read(`/${row.id}`, { fields: "id,is_on_biz_app,platform_type" }, signal)); }
        catch (error) {
          if (!(error instanceof MetaGraphClientError) || error.retryable || ![400, 403].includes(error.providerStatus ?? 0)) throw error;
          // Older pinned Graph capability can omit these fields. That is not standard-number proof.
        }
        const facts = metaSignupPhone({ ...row, is_on_biz_app: variant?.id === row.id ? variant?.is_on_biz_app : undefined, platform_type: variant?.id === row.id ? variant?.platform_type : undefined }, String(row.id));
        const admission = metaSignupChoiceAdmission({ ...facts, phoneId: String(row.id), wabaId }, undefined, "NEW_NUMBER", this.config.variant);
        let lastOnboardedTime: number | undefined;
        if (admission.selectable && this.config.variant === "BUSINESS_APP") {
          try {
            const timestamp = object(await this.read(`/${row.id}`, { fields: "id,last_onboarded_time" }, signal));
            if (timestamp && timestamp.id === row.id && Number.isSafeInteger(timestamp.last_onboarded_time)
              && Number(timestamp.last_onboarded_time) > 0 && Number(timestamp.last_onboarded_time) <= Math.floor(Date.now() / 1000)) {
              lastOnboardedTime = Number(timestamp.last_onboarded_time);
            }
          } catch (error) {
            // Optional timestamp support cannot invent a fresh window or veto the actual one-shot request.
            if (!(error instanceof MetaGraphClientError)) throw error;
          }
        }
        choices.push({ choiceId: randomUUID(), businessId: owner.id, wabaId, phoneId: String(row.id),
          businessName: label(owner.name), accountName: label(account.name), displayPhoneNumber: label(row.display_phone_number),
          ...(typeof row.verified_name === "string" ? { verifiedName: label(row.verified_name) } : {}),
          mode: facts.mode, numberState: facts.numberState, ...admission,
          ...(lastOnboardedTime !== undefined ? { lastOnboardedTime } : {}),
          proofSha256: createHash("sha256").update(JSON.stringify({ owner: owner.id, wabaId, row, facts })).digest("hex") });
      }
    }
    return { metadata, choices };
  }

  private read(path: string, query: Record<string, string>, signal?: AbortSignal) {
    return metaGraphRequest(this.transport, path, "GET", "read", undefined, query, signal, this.token);
  }

  private async list(path: string, fields: string, signal: AbortSignal) {
    const result: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      signal.throwIfAborted();
      const response = object(await this.read(path, { fields, limit: "100", ...(after ? { after } : {}) }, signal));
      if (!Array.isArray(response?.data) || response.data.length > 100) throw unavailable();
      for (const item of response.data) {
        const row = object(item);
        if (!row || !metaId(row.id) || result.some(existing => existing.id === row.id)) throw unavailable();
        result.push(row);
      }
      const paging = object(response.paging);
      if (response.paging !== undefined && !paging) throw unavailable();
      if (paging?.next === undefined) return result;
      const cursor = object(paging.cursors)?.after;
      if (typeof paging.next !== "string" || typeof cursor !== "string" || !/^[A-Za-z0-9_+/=-]{1,2048}$/u.test(cursor) || seen.has(cursor)) throw unavailable();
      seen.add(cursor); after = cursor;
    }
    throw unavailable();
  }
}

// eslint-disable-next-line no-control-regex -- Remove ASCII control bytes from untrusted provider display labels.
function label(value: unknown) { return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/gu, "").slice(0, 160) : ""; }
function unavailable(outcomeKnown = true) { return new MetaGraphClientError("META_SIGNUP_DISCOVERY_UNAVAILABLE", "Meta account details could not be verified.", false, undefined, outcomeKnown); }
