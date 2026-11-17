const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNED_PATH = /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/u;

export type SecretOwner =
  | { kind: "meta-signup"; tenantId: string; attemptId: string }
  | { kind: "meta-connection"; tenantId: string; connectionId: string }
  | { kind: "waha-webhook"; tenantId: string; connectionId: string }
  | { kind: "zammad"; tenantId: string; purpose: "service" | "privacy" }
  | { kind: "routing"; tenantId: string }
  | { kind: "bot-action"; tenantId: string; actionKey: string; actionKind: string }
  | { kind: "exact"; expectedReference: string };

export function isOwnedSecretReference(reference: string, owner: SecretOwner) {
  if (owner.kind === "meta-signup") return reference === `secret://${owner.tenantId}/meta-signup/${owner.attemptId}`;
  if (owner.kind === "exact") return reference === owner.expectedReference;
  if (owner.kind === "zammad") return reference === `secret://tenants/${owner.tenantId}/zammad/${owner.purpose}`;
  if (owner.kind === "waha-webhook") return reference === `secret://${owner.tenantId}/connections/${owner.connectionId}/webhook`;
  if (owner.kind === "meta-connection") {
    const base = `secret://${owner.tenantId}/connections/${owner.connectionId}/meta`;
    const rotation = `${base}/rotations/`;
    return reference === base || reference.startsWith(rotation) && /^[0-9a-f]{64}$/u.test(reference.slice(rotation.length));
  }
  if (owner.kind === "routing") {
    const prefix = `secret://tenants/${owner.tenantId}/routing/`;
    return reference.startsWith(prefix) && OWNED_PATH.test(reference.slice(prefix.length));
  }
  const actionPrefix = `secret://tenants/${owner.tenantId}/bot-actions/${owner.actionKey}`;
  const ownedAction = reference === actionPrefix || reference.startsWith(`${actionPrefix}/credentials/`) &&
    /^[0-9a-f]{64}$/u.test(reference.slice(`${actionPrefix}/credentials/`.length));
  if (owner.actionKind === "HTTP_JSON") return ownedAction;
  const integrationPrefix = `secret://tenants/${owner.tenantId}/routing/integrations/`;
  return owner.actionKind === "NOTION_CREATE_PAGE" && (ownedAction ||
    reference.startsWith(integrationPrefix) && UUID.test(reference.slice(integrationPrefix.length)));
}
