import type { Pool } from "pg";
import { setTimeout } from "node:timers/promises";

const MANAGED_WORKER_KEY = /^managed-(?:gows|noweb)-\d{1,2}$/u;
const SAFE_GATE_FAILURE = /^managed WAHA worker (managed-(?:gows|noweb)-\d{1,2}) cannot leave the registry: state ([A-Z_]+), protected assignments ([0-9]+)$/u;

export type DesiredManagedWorker = {
  workerKey: string;
  engine: "GOWS" | "NOWEB";
  baseUrl: string;
  secretReference: string;
};

export function parseDesiredManagedWorkers(raw: string | undefined): DesiredManagedWorker[] {
  if (raw === undefined) throw new Error("WAHA_DESIRED_MANAGED_WORKERS_JSON is required");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("WAHA desired managed worker keys must be valid JSON");
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("WAHA desired managed worker keys must contain at most 100 items");
  }
  const workers = value.map((candidate): DesiredManagedWorker => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("WAHA desired managed worker is invalid");
    }
    const worker = candidate as Record<string, unknown>;
    if (
      Object.keys(worker).sort().join(",") !== "baseUrl,engine,secretReference,workerKey" ||
      typeof worker.workerKey !== "string" || !MANAGED_WORKER_KEY.test(worker.workerKey) ||
      (worker.engine !== "GOWS" && worker.engine !== "NOWEB") ||
      typeof worker.baseUrl !== "string" || !isPrivateManagedUrl(worker.baseUrl) ||
      typeof worker.secretReference !== "string" ||
      worker.secretReference.length > 512 ||
      !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(worker.secretReference)
    ) {
      throw new Error("WAHA desired managed worker identity is invalid");
    }
    return worker as DesiredManagedWorker;
  });
  if (new Set(workers.map((worker) => worker.workerKey)).size !== workers.length) {
    throw new Error("WAHA desired managed worker identities are duplicated");
  }
  return workers;
}

export async function assertWahaRegistryTransition(
  pool: Pick<Pool, "query">,
  desiredWorkers: DesiredManagedWorker[],
) {
  const result = await pool.query<{
    checked_workers: number | string;
    omitted_workers: number | string;
  }>(
    "SELECT checked_workers,omitted_workers FROM app.assert_waha_worker_registry_transition($1::jsonb)",
    [JSON.stringify(desiredWorkers)],
  );
  const row = result.rows[0];
  const checkedWorkers = Number(row?.checked_workers);
  const omittedWorkers = Number(row?.omitted_workers);
  if (
    result.rows.length !== 1 ||
    !Number.isSafeInteger(checkedWorkers) || checkedWorkers < 0 ||
    !Number.isSafeInteger(omittedWorkers) || omittedWorkers < 0 ||
    omittedWorkers > checkedWorkers
  ) {
    throw new Error("WAHA rollout gate returned an invalid result");
  }
  return { checkedWorkers, omittedWorkers };
}

export async function runWahaRolloutPreflight(pool: Pool, desiredWorkers: DesiredManagedWorker[]) {
  let client;
  for (let attempt = 1; ; attempt++) {
    try {
      client = await pool.connect();
      break;
    } catch (error) {
      // New pod network rules may still be converging. Retry only before SQL.
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" || attempt >= 6) throw error;
      await setTimeout(3_000);
    }
  }
  try {
    return await assertWahaRegistryTransition(client, desiredWorkers);
  } finally {
    client.release();
  }
}

function isPrivateManagedUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      url.username === "" && url.password === "" &&
      /(?:\.svc\.(?:cluster\.local|[a-z0-9.-]+\.(?:internal|local)))$/u.test(url.hostname) &&
      url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function safeRolloutFailureEvidence(error: unknown): {
  worker: string;
  state: string;
  protectedAssignments: number;
} | undefined {
  if (!error || typeof error !== "object" || !("code" in error) || !("message" in error)) {
    return undefined;
  }
  if (error.code !== "P0001" || typeof error.message !== "string") return undefined;
  const match = SAFE_GATE_FAILURE.exec(error.message);
  if (!match) return undefined;
  const protectedAssignments = Number(match[3]);
  if (!Number.isSafeInteger(protectedAssignments) || protectedAssignments < 0) return undefined;
  return {
    worker: match[1]!,
    state: match[2]!,
    protectedAssignments,
  };
}

export function safeRolloutFailureCategory(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "ENOENT": return "trust_bundle_missing";
    case "ECONNREFUSED": return "connection_refused";
    case "ETIMEDOUT": return "connection_timeout";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID": return "tls_failed";
    case "28P01": return "authentication_failed";
    case "42501": return "authorization_failed";
    case "42883": return "database_contract_missing";
    default: return "internal";
  }
}
