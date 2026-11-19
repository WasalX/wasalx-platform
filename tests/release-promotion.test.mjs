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
  assert.match(script, /^  gh release upload "\$GITHUB_REF_NAME" "\$manifest" --repo "\$GITHUB_REPOSITORY" --clobber$/mu);

  const lines = script.replace(/[ \t]*\\\r?\n[ \t]*/gu, " ").split(/\r?\n/u);
  assert(lines.includes('[[ "$GITHUB_REF_NAME" =~ ^v[A-Za-z0-9_.-]{0,127}$ ]]'));
  assert(lines.includes(`run=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch main --event push --commit "$commit" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')`));
  assert(lines.includes('  if [[ "$GITHUB_REF_NAME" == v*-rc.* ]]; then flags+=(--prerelease); fi'));
  assert.equal(workflow.jobs.stg.if, "${{ github.repository == 'WasalX/wasalx-platform' && contains(github.ref_name, '-rc.') }}");
  assert.equal(workflow.jobs.stg.steps[0].run, '[[ "$GITHUB_REF_NAME" == v*-rc.* ]]');
  assert.equal(workflow.jobs.prod.if, "${{ !contains(github.ref_name, '-rc.') }}");
  assert.match(workflow.jobs.prod.steps[0].run, /^\[\[ "\$\{GITHUB_REF_NAME,,\}" != \*-rc\.\* \]\] \|\| \{ [^\n]*; exit 1; \}$/mu);
});
