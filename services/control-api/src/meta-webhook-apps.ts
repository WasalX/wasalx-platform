import { readFileSync } from "node:fs";
import { isWebhookSecretReference } from "./webhook-secret.service.js";

export type MetaWebhookApp = Readonly<{ appId: string; secretReference: string; verifyTokenReference: string }>;

export function loadMetaWebhookApps(path: string | undefined): ReadonlyMap<string, MetaWebhookApp> | undefined {
  if (!path) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("META_WEBHOOK_APPS_FILE must contain readable JSON");
  }
  if (!isRecord(config) || Object.keys(config).length !== 2 || config.schemaVersion !== 1
      || !Array.isArray(config.apps) || config.apps.length === 0) {
    throw new Error("META_WEBHOOK_APPS_FILE must contain a version 1 app registry");
  }
  const apps = new Map<string, MetaWebhookApp>();
  const references = new Set<string>();
  for (const [index, row] of config.apps.entries()) {
    if (!isRecord(row) || Object.keys(row).length !== 3 || typeof row.appId !== "string" || !/^[0-9]{5,32}$/u.test(row.appId)
        || !isWebhookSecretReference(row.secretReference) || !isWebhookSecretReference(row.verifyTokenReference)
        || row.secretReference === row.verifyTokenReference || apps.has(row.appId)
        || references.has(row.secretReference) || references.has(row.verifyTokenReference)) {
      throw new Error(`META_WEBHOOK_APPS_FILE has an invalid or duplicate app row at index ${index}`);
    }
    const { appId, secretReference, verifyTokenReference } = row;
    apps.set(appId, Object.freeze({ appId, secretReference, verifyTokenReference }));
    references.add(secretReference);
    references.add(verifyTokenReference);
  }
  return apps;
}

export function matchesMetaWebhookApp(route: { provider: string; hmac_secret_reference: string }, reference?: string) {
  return reference === undefined || (route.provider === "META" && route.hmac_secret_reference === reference);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
