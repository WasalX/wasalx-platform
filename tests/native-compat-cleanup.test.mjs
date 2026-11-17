import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNativeCompatibilityProjectEmpty, settleNativeCompatibility } from "./fixtures/native-compat-cleanup.mjs";

function fixture({ fail, residue, primaryError, runnerConnected = true } = {}) {
  const calls = [], diagnostics = []; let removed = false;
  const options = { project: "wasalx-zammad-123", directory: "/tmp/owned-native", runnerContainer: "owned-runner", runnerConnected, primaryError,
    closeBrowser: async () => { calls.push("browser"); if (fail === "browser") throw new Error("browser failed"); },
    closeFixture: async () => { calls.push("fixture"); },
    command: (args) => { calls.push(args);
      if ((fail === "disconnect" && args[1] === "disconnect") || (fail === "down" && args[0] === "compose") || (fail === "inspect" && args[1] === "ls")) throw new Error("command failed");
      return args[1] === "ls" && args[0] === residue ? "owned-id\n" : "";
    },
    removeWorkspace: async () => { removed = true; },
    writeDiagnostics: async (value) => { diagnostics.push(value); },
  };
  return { options, calls, diagnostics, removed: () => removed };
}
test("cleanup removes workspace only after exact owned resource absence", async () => {
  const f = fixture(); await settleNativeCompatibility(f.options); assert.equal(f.removed(), true);
  for (const args of f.calls.filter(Array.isArray).filter(x => x[1] === "ls")) assert.ok(args.includes("label=com.docker.compose.project=wasalx-zammad-123"));
  assert.equal(f.calls.filter(Array.isArray).filter(x => x[1] === "ls").length, 3);
});

test("cleanup awaits async Docker commands and still denies failures or residue", async () => {
  for (const overrides of [{}, { fail: "down" }, { residue: "volume" }]) {
    const f = fixture(overrides), command = f.options.command;
    f.options.command = async args => command(args);
    if (overrides.fail || overrides.residue) {
      await assert.rejects(settleNativeCompatibility(f.options), AggregateError);
      assert.equal(f.removed(), false);
    } else {
      await settleNativeCompatibility(f.options); assert.equal(f.removed(), true);
    }
    assert.equal(f.calls.filter(Array.isArray).filter(args => args[1] === "ls").length, 3);
  }
});
for (const fail of ["disconnect", "down", "inspect", "browser"]) test(`cleanup propagates ${fail} and still attempts remaining settlement`, async () => {
  const f = fixture({ fail }); await assert.rejects(settleNativeCompatibility(f.options), AggregateError);
  assert.equal(f.removed(), false); assert.equal(f.diagnostics.length, 1);
  assert.equal(f.calls.filter(Array.isArray).filter(x => x[1] === "ls").length, 3);
});
for (const residue of ["container", "network", "volume"]) test(`cleanup denies ${residue} residue`, async () => {
  const f = fixture({ residue }); await assert.rejects(settleNativeCompatibility(f.options), AggregateError);
  assert.equal(f.removed(), false); assert.equal(f.diagnostics[0].resources[residue].count, 1);
});
test("original scenario failure retains workspace even after complete Docker settlement", async () => {
  const error = new Error("scenario failed"), f = fixture({ primaryError: error, runnerConnected: false });
  await assert.rejects(settleNativeCompatibility(f.options), e => e instanceof AggregateError && e.errors.includes(error));
  assert.equal(f.removed(), false); assert.equal(f.calls.filter(Array.isArray).some(x => x[1] === "disconnect"), false);
});
test("diagnostics write failure preserves the original failure and completed settlement", async () => {
  const primaryError = new Error("scenario failed"), diagnosticError = new Error("diagnostics failed");
  const f = fixture({ primaryError });
  f.options.writeDiagnostics = async () => { throw diagnosticError; };
  await assert.rejects(settleNativeCompatibility(f.options), error =>
    error instanceof AggregateError && error.errors.includes(primaryError) && error.errors.includes(diagnosticError));
  assert.equal(f.removed(), false);
  assert.equal(f.calls.filter(Array.isArray).filter(args => args[1] === "ls").length, 3);
});

const selectedProject = "wasalx-zammad-01234567-89ab-4cde-8fab-0123456789ab";
const siblingProject = "wasalx-zammad-01234567-89ab-4cde-8fab-0123456789ac";
function projectCensus({ rows = [], failAt = -1, responses = {} } = {}) {
  const calls = [], effects = [], readError = new Error("Census failed");
  const expected = [
    ...["container", "network", "volume"].map(kind => [kind, "ls", ...(kind === "container" ? ["--all"] : []),
      "--quiet", "--filter", `label=com.docker.compose.project=${selectedProject}`]),
    ["container", "ls", "--all", "--format", "{{.Names}}"],
    ["network", "ls", "--format", "{{.Name}}"],
    ["volume", "ls", "--format", "{{.Name}}"],
  ];
  const command = (args) => {
    if (args[1] !== "ls") effects.push(args);
    const index = calls.length; calls.push(args);
    assert.deepEqual(args, expected[index]);
    if (index === failAt) throw readError;
    if (Object.hasOwn(responses, index)) return responses[index];
    return rows.filter(row => row.kind === args[0] && (args.includes("--format") || row.label === selectedProject))
      .map(row => args.includes("--format") ? row.name : row.id).join("\n");
  };
  return { command, calls, effects, readError, expected };
}

test("project admission preserves legacy foreign volumes and a sibling UUID project", () => {
  const rows = [
    ...["zammad-storage", "zammad-backup"].map(suffix => ({ kind: "volume", id: `legacy-${suffix}`,
      name: `wasalx-zammad-3995630_${suffix}`, label: "wasalx-zammad-3995630" })),
    { kind: "container", id: "sibling-container", name: `${siblingProject}-zammad-railsserver-1`, label: siblingProject },
    { kind: "network", id: "sibling-network", name: `${siblingProject}_default`, label: siblingProject },
  ];
  const before = structuredClone(rows), f = projectCensus({ rows });
  assert.deepEqual(assertNativeCompatibilityProjectEmpty({ project: selectedProject, command: f.command }), {
    project: selectedProject, resources: { container: 0, network: 0, volume: 0 },
    namedResources: { container: 0, network: 0, volume: 0 },
  });
  assert.deepEqual(f.calls, f.expected); assert.deepEqual(f.effects, []); assert.deepEqual(rows, before);
});

for (const kind of ["container", "network", "volume"]) test(`project admission denies labelled ${kind} occupancy without effects`, () => {
  const f = projectCensus({ rows: [{ kind, id: "occupied", name: "unrelated-name", label: selectedProject }] });
  assert.throws(() => assertNativeCompatibilityProjectEmpty({ project: selectedProject, command: f.command }), /not empty/u);
  assert.deepEqual(f.effects, []);
});

for (let index = 0; index < 6; index++) test(`project admission propagates census ${index + 1} failure without effects`, () => {
  const f = projectCensus({ failAt: index });
  assert.throws(() => assertNativeCompatibilityProjectEmpty({ project: selectedProject, command: f.command }), error => error === f.readError);
  assert.equal(f.calls.length, index + 1); assert.deepEqual(f.effects, []);
});

for (let index = 0; index < 6; index++) test(`project admission rejects unknown census ${index + 1} result without effects`, () => {
  const f = projectCensus({ responses: { [index]: undefined } });
  assert.throws(() => assertNativeCompatibilityProjectEmpty({ project: selectedProject, command: f.command }), /Unknown.*result/u);
  assert.equal(f.calls.length, index + 1); assert.deepEqual(f.effects, []);
});

for (const [kind, suffix] of [["container", "-zammad-railsserver-1"], ["network", "_default"],
  ["volume", "_zammad-storage"], ["volume", "_zammad-backup"]]) {
  for (const label of [undefined, siblingProject]) test(`project admission denies ${kind}${suffix} with ${label ? "wrong" : "absent"} label`, () => {
    const f = projectCensus({ rows: [{ kind, id: "occupied", name: selectedProject + suffix, label }] });
    assert.throws(() => assertNativeCompatibilityProjectEmpty({ project: selectedProject, command: f.command }), /name scope is not empty/u);
    assert.deepEqual(f.effects, []);
  });
}

test("project admission fences exact container names and underscore or comma-separated aliases", () => {
  for (const name of [selectedProject, `${selectedProject}_zammad_1`, `unrelated,${selectedProject}-zammad-1`]) {
    const f = projectCensus({ rows: [{ kind: "container", id: "occupied", name }] });
    assert.throws(() => assertNativeCompatibilityProjectEmpty({ project: selectedProject, command: f.command }), /container name scope is not empty/u);
    assert.deepEqual(f.effects, []);
  }
});

test("project admission rejects malformed container aliases without effects", () => {
  const f = projectCensus({ responses: { 3: "unrelated,,other" } });
  assert.throws(() => assertNativeCompatibilityProjectEmpty({ project: selectedProject, command: f.command }), /Unknown.*result/u);
  assert.deepEqual(f.effects, []);
});

test("project admission rejects invalid projects before any query or effect", () => {
  for (const project of [undefined, null, 1, "wasalx-zammad-3995630", selectedProject.toUpperCase(),
    selectedProject.replace("-4cde-", "-1cde-"), selectedProject.replace("-8fab-", "-7fab-"),
    `${selectedProject}\n`, `${selectedProject}-suffix`]) {
    const f = projectCensus();
    assert.throws(() => assertNativeCompatibilityProjectEmpty({ project, command: f.command }), /UUIDv4/u);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.effects, []);
  }
});
