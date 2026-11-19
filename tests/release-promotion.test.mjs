import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("release promotion uses existing tags and the intended environment protections", async () => {
  const [source, script] = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release/promote-tag.sh", import.meta.url), "utf8"),
  ]);
  const workflow = parse(source);
  assert.deepEqual(workflow.on, { push: { tags: ["v*"] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["prod", "stg"]);
  const commands = [script];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.environment, name);
    assert.deepEqual(job.permissions, { actions: "read", contents: "write", packages: "write" });
    assert(job.steps.some(step => step.run === "bash scripts/release/promote-tag.sh"));
    commands.push(...job.steps.map(step => step.run ?? ""));
  }
  const shell = commands.join("\n");
  assert.doesNotMatch(shell, /\bgit\s+(?:tag|push|update-ref)\b|\/git\/refs\b/u);
  const releaseCommands = shell.match(/\bgh release (?:create|new)\b[^\n]*/gu) ?? [];
  assert.equal(releaseCommands.length, 1);
  assert.match(releaseCommands[0], /\s--verify-tag\s/u);
  assert.match(workflow.jobs.stg.if, /contains\(github\.ref_name, '-rc\.'\)/u);
  assert.equal(workflow.jobs.prod.if, "${{ !contains(github.ref_name, '-rc.') }}");
  assert.match(workflow.jobs.prod.steps[0].run, /\[\[ "\$\{GITHUB_REF_NAME,,\}" != \*-rc\.\* \]\][^\n]*exit 1/u);
});
