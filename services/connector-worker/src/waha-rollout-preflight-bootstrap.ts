import { Pool } from "pg";
import {
  runWahaRolloutPreflight,
  parseDesiredManagedWorkers,
  safeRolloutFailureEvidence,
  safeRolloutFailureCategory,
} from "./waha-rollout-preflight.js";

const connectionString = process.env.WAHA_ROLLOUT_GATE_DATABASE_URL;
if (!connectionString) throw new Error("WAHA_ROLLOUT_GATE_DATABASE_URL is required");
const desiredWorkers = parseDesiredManagedWorkers(
  process.env.WAHA_DESIRED_MANAGED_WORKERS_JSON,
);
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  application_name: "wasalx-waha-rollout-gate",
});

try {
  const result = await runWahaRolloutPreflight(pool, desiredWorkers);
  // Worker keys and counts are platform infrastructure. Tenant IDs, provider
  // session IDs, phone numbers, endpoints, secret references, and bodies are
  // deliberately absent from hook output.
  process.stdout.write(`${JSON.stringify({
    event: "waha.rollout_gate.passed",
    checked_workers: result.checkedWorkers,
    omitted_workers: result.omittedWorkers,
  })}\n`);
} catch (error) {
  const evidence = safeRolloutFailureEvidence(error);
  if (evidence) {
    process.stderr.write(`${JSON.stringify({
      event: "waha.rollout_gate.blocked",
      worker: evidence.worker,
      state: evidence.state,
      protected_assignments: evidence.protectedAssignments,
    })}\n`);
  } else {
    process.stderr.write(`${JSON.stringify({
      event: "waha.rollout_gate.failed",
      category: safeRolloutFailureCategory(error),
    })}\n`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
