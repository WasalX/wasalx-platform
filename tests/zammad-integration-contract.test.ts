import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {runInNewContext} from "node:vm";
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
test("the WasalX compiler delegates package frontend validation to Zammad", async () => {
  const tsconfig = JSON.parse(
    await readFile(path.join(workspace, "tsconfig.json"), "utf8"),
  ) as { exclude?: string[] };
  assert.ok(
    tsconfig.exclude?.includes("zammad-package/app/frontend/**/*"),
    "Zammad-only aliases must be compiled by Zammad's pinned frontend toolchain",
  );
  assert.ok(
    tsconfig.exclude?.includes("tests/fixtures/zammad-*/app/frontend/**/*"),
    "Staged upstream snapshots are add-on fixtures, not platform TypeScript inputs",
  );
});

test("native expected denials reject timeout, signal and unknown process failures", async () => {
  const source = await readFile(path.join(workspace, "tests/zammad-image-browser-compat.test.mjs"), "utf8");
  const start = source.indexOf("function rejectedDocker("), end = source.indexOf("\nasync function availablePort()", start);
  assert.ok(start >= 0 && end > start);
  const denied = Object.assign(new Error("migration denied"), { status: 1, signal: null, stderr: "rollback blocked" });
  for (const error of [denied,
    Object.assign(new Error("timeout"), { code: "ETIMEDOUT", status: 1, stderr: denied.stderr }),
    Object.assign(new Error("signal"), { status: 1, signal: "SIGKILL", stderr: denied.stderr }),
    Object.assign(new Error("spawn"), { code: "ENOENT", status: null, stderr: denied.stderr }),
    Object.assign(new Error("unknown"), { status: null, signal: null, stderr: denied.stderr }),
  ]) {
    const rejected = runInNewContext(source.slice(start, end) + ";rejectedDocker", { docker: () => { throw error; } });
    if (error === denied) assert.match(rejected("fixture", "owned"), /rollback blocked/u);
    else assert.throws(() => rejected("fixture", "owned"), value => value === error);
  }
  const succeeded = runInNewContext(source.slice(start, end) + ";rejectedDocker", { docker: () => "" });
  assert.throws(() => succeeded("fixture", "owned"), /unexpectedly succeeded/u);
});

test("the exact-image gate proves rollback and every compiled Zammad extension surface", async () => {
  const gate = await readFile(path.join(workspace, "tests/zammad-image-browser-compat.test.mjs"), "utf8");
  assert.match(gate, /docker\(directory, project, "run", "--rm", "--no-deps", "zammad-package-predecessor"\);/u);
  assert.match(gate, /const blockedUpgrade = rejectedDocker\(directory, project, "run", "--rm", "--no-deps", "zammad-package"\);/u);
  const installCurrent = gate.indexOf('docker(directory, project, "run", "--rm", "--no-deps", "zammad-package");', gate.indexOf("destroy!"));
  const rollbackCurrent = gate.indexOf('docker(directory, project, "run", "--rm", "--no-deps", "zammad-package-rollback");', installCurrent);
  const reinstallCurrent = gate.indexOf('docker(directory, project, "run", "--rm", "--no-deps", "zammad-package");', rollbackCurrent);
  assert.ok(installCurrent >= 0 && installCurrent < rollbackCurrent && rollbackCurrent < reinstallCurrent);
  assert.match(gate, /assignmentProof[\s\S]*revision\), 2/u);
  assert.match(gate, /rollbackAssignmentProof[\s\S]*revision\), 4/u);
  assert.match(gate, /routing_assignment_revision[\s\S]*revision\), 1/u);
  assert.match(gate, /prepare-zammad-compatibility-artifacts\.mjs/u);

  assert.match(gate, /name: "Reply on WhatsApp"/u);
  assert.match(gate, /name: "WasalX operations"/u);
  assert.match(gate, /getByRole\("region", \{ name: "Riyadh Operations" \}\)/u);
  assert.match(gate, /for \(const width of \[820, 390\]\)/u);
  assert.match(gate, /page\.setViewportSize\(\{ width, height: 844 \}\)/u);
  assert.match(gate, /page\.setViewportSize\(\{ width: 1440, height: 1000 \}\)/u);
  assert.match(gate, /articleBubble\.getByRole\("button", \{ name: "Reply on WhatsApp" \}\)/u);
  assert.match(gate, /compiledPlugins: \{ workspaceRoute: true, ticketSidebar: true, ticketArticleAction: true \}/u);
  assert.match(gate, /postmaster_routing_jobs_in_transaction: postmaster_routing_jobs_in_transaction/u);
  assert.match(gate, /postmaster_routing_jobs_rolled_back: postmaster_routing_jobs_rolled_back/u);
  assert.match(gate, /postmaster_pending_marker_rolled_back: postmaster_pending_marker_rolled_back/u);
  assert.match(gate, /committed_job\.payload_object\.perform/u);
  assert.match(gate, /routing_jobs_after_success: routing_jobs_after_success/u);
  assert.match(gate, /Service::Ticket::Article::Type::WasalxGroupMessage::Deliver\.execute/u);
  assert.equal(gate.match(/EventBuffer\.list\('transaction'\)\.empty\?/gu)?.length, 2);
  assert.match(gate, /assert\.equal\(seeded\.routing_event_buffer_empty, true\)/u);
  assert.match(gate, /assert\.equal\(seeded\.delivery_event_buffer_empty, true\)/u);
});

test("proprietary preflight preserves the add-on integration route", async () => {
 const internalControllerSource=await readFile(path.join(workspace,"services/control-api/src/zammad-internal.controller.ts"),"utf8");
  assert.match(internalControllerSource, /@Get\("outbound\/preflight"\)/);
});
