import { createHash } from "node:crypto";
import { isOwnedSecretReference } from "@wasalx/core/secret-reference";

export function wahaWebhookSecretReference(tenantId: string, connectionId: string) {
  return `secret://${tenantId}/connections/${connectionId}/webhook`;
}

export function metaCredentialSecretReference(tenantId: string, connectionId: string) {
  return `secret://${tenantId}/connections/${connectionId}/meta`;
}

export function metaCredentialRotationReference(
  tenantId: string,
  connectionId: string,
  idempotencyKey: string,
) {
  return `${metaCredentialSecretReference(tenantId, connectionId)}/rotations/${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export function isMetaCredentialSecretReference(
  reference: string,
  tenantId: string,
  connectionId: string,
) {
  return isOwnedSecretReference(reference,{kind:"meta-connection",tenantId,connectionId});
}

export function isTenantOwnedSecretReference(reference: string, tenantId: string) {
  const connectionPrefix = `secret://${tenantId}/connections/`;
  if (reference.startsWith(connectionPrefix)) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:webhook|meta(?:\/rotations\/[0-9a-f]{64})?)$/u.test(
      reference.slice(connectionPrefix.length),
    );
  }
  for (const prefix of [
    `secret://tenants/${tenantId}/bot-actions/`,
  ]) {
    if (reference.startsWith(prefix)) {
      return /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/u.test(reference.slice(prefix.length));
    }
  }
  return isOwnedSecretReference(reference,{kind:"routing",tenantId});
}
