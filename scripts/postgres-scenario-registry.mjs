import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Scenario timings from Actions run 45001010261, before runner setup and builds.
export const postgresScenarioGroups = [
  // Keep the shared fixtures and the direct-identity history from before migration 0171 together.
  [ // 88.4 s
    "migrations", "sharedCore", "metaDirectIdentity", "metaTemplatePreparation",
    "metaAccountIdentitySuccessor", "metaCostHistoricalRepair", "metaLegacyNullBilling",
    "metaCostFactInterleavings", "metaAccountPolicy", "metaCostProducer", "metaCostTariffAdmissions",
    "metaPricingObservations", "metaBillingDiagnostics", "nativeRouting",
  ],
  [ // 88.3 s
    "metaLegacyMigration", "metaManagedSoftware", "metaTransitionOperatorReviews",
    "metaPublicTariffAcceptance", "postgresLoadRecovery", "metaCostRetention", "metaCostCustomerHistory",
    "metaLifecycle/worker",
  ],
  [ // 88.2 s
    "metaCostStatements", "metaSignup", "metaDeletion", "metaCostAgedExpiry", "metaCostMoney",
    "metaTransitionSuccessors", "metaCostSelectorSemantics", "metaCostPrivacyFences",
    "currentOperatorLocks", "nativeMembership",
  ],
  [ // 88.2 s
    "metaCostFactAndBatchBounds", "metaNumberRelease", "metaCostSnapshotBound",
    "metaTransitionObserverRenewal", "metaCostLookupPrivacy", "metaCostCausalOrders",
    "metaTransitionExecution", "metaCostActivationInterleaving", "metaLifecycle/consumers",
    "metaLifecycle/ingress",
  ],
];

const registry = new Map(postgresScenarioGroups.flatMap((names, index) => names.map(name => [name, index + 1])));
assert.equal(registry.size, postgresScenarioGroups.flat().length, "Duplicate PostgreSQL scenario in registry");

export function scenarioShard(name) {
  assert(registry.has(name), "Unregistered PostgreSQL scenario: " + name);
  return registry.get(name);
}

export function parsePostgresShardArgs(args) {
  if (args.length === 0) return {};
  const [flag, selection, reportFlag, report] = args;
  const match = /^([1-4])\/4$/u.exec(selection ?? "");
  if (flag !== "--shard" || !match || (args.length !== 2 && (args.length !== 4 || reportFlag !== "--report" || !report))) {
    throw new Error("Usage: node scripts/test-postgres-integration.mjs [--shard 1/4 ... 4/4 [--report file]]");
  }
  return { shard: Number(match[1]), report };
}

export function verifyPostgresShard(shard, executed) {
  const expected = postgresScenarioGroups[shard - 1];
  assert(expected, "Unknown PostgreSQL shard: " + shard);
  assert(Array.isArray(executed), "Missing PostgreSQL scenario list for shard " + shard);
  assert.deepEqual(executed.toSorted(), expected.toSorted(), "Incomplete or duplicate coverage in PostgreSQL shard " + shard);
}

export async function verifyPostgresReports(directory) {
  const files = postgresScenarioGroups.map((_, index) => "postgres-shard-" + (index + 1) + ".json");
  assert.deepEqual((await readdir(directory)).sort(), files, "Expected one report from each PostgreSQL shard");
  for (const [index, file] of files.entries()) {
    const { shard, scenarios } = JSON.parse(await readFile(join(directory, file), "utf8"));
    assert.equal(shard, index + 1, "PostgreSQL shard report identity mismatch");
    verifyPostgresShard(shard, scenarios);
  }
  return registry.size;
}

if (import.meta.main) {
  const count = await verifyPostgresReports(process.argv[2]);
  console.log("Verified exactly-once coverage of " + count + " PostgreSQL scenarios");
}
