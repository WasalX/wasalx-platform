import type { ProviderGateway } from "./kubernetes.js";
import type { ProviderStore } from "./repository.js";
import { ProviderError, type ProviderRequest, type ProviderResponse } from "./types.js";

export class WorkspaceProviderService {
  constructor(private readonly store: ProviderStore, private readonly gateway: ProviderGateway) {}

  async execute(input: ProviderRequest): Promise<ProviderResponse> {
    const claim = await this.store.claim(input);
    if (claim.kind === "REPLAY") return claim.response;
    try {
      const evidence = await this.gateway.reconcile(input);
      const response: ProviderResponse = {
        status: "READY",
        tenant_id: input.tenant_id,
        action: input.action,
        fencing_token: input.fencing_token,
        idempotency_key: input.idempotency_key,
        evidence,
      };
      await this.store.complete(input, claim.token, response);
      return response;
    } catch (error) {
      const failure = error instanceof ProviderError
        ? error
        : new ProviderError(503, "PROVIDER_UNAVAILABLE", "The workspace provider is temporarily unavailable.", true);
      if (failure.retryable) {
        await this.store.release(input, claim.token, failure.code);
      } else {
        await this.store.fail(input, claim.token, failure.code, true);
        try {
          await this.store.rollbackIfAuthoritative(
            input,
            claim.token,
            () => this.gateway.rollback(input),
          );
        } catch {
          // The durable ROLLBACK_PENDING state is intentionally retained for
          // an operator or the replay worker; a failed compensating action is
          // never reported as success.
        }
      }
      throw failure;
    }
  }

  async ready() {
    const [database, providerControlPlane] = await Promise.all([this.store.ready(), this.gateway.ready()]);
    return { ready: database && providerControlPlane, database, providerControlPlane };
  }
}
