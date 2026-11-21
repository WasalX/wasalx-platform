import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

test("release promotion uses existing tags and the intended environment protections", async () => {
  const [source, script, helper] = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release/promote-tag.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release/image-manifest.sh", import.meta.url), "utf8"),
  ]);
  const workflow = parse(source);
  assert.deepEqual(workflow.on, { push: { tags: ["v*"] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["prod", "stg"]);
  const commands = [script, helper];
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
  assert.match(script, /^ {2}gh release upload "\$GITHUB_REF_NAME" "\$manifest" --repo "\$GITHUB_REPOSITORY" --clobber$/mu);

  const lines = script.replace(/[ \t]*\\\r?\n[ \t]*/gu, " ").split(/\r?\n/u);
  assert(lines.includes('[[ "$GITHUB_REF_NAME" =~ ^v[A-Za-z0-9_.-]{0,127}$ ]]'));
  assert(lines.includes("source scripts/release/image-manifest.sh"));
  assert(lines.includes('require_tag_commit "$GITHUB_REF" "$commit"'));
  assert(lines.includes('download_main_image_manifest "$commit" "$directory"'));
  assert.match(helper, /--workflow ci\.yml --branch main[^\n]*\n\s*--event push --commit "\$commit" --status success/u);
  assert(lines.includes('  if [[ "$GITHUB_REF_NAME" == v*-rc.* ]]; then flags+=(--prerelease); fi'));
  assert.equal(workflow.jobs.stg.if, "${{ github.repository == 'WasalX/wasalx-platform' && contains(github.ref_name, '-rc.') }}");
  assert.equal(workflow.jobs.stg.steps[0].run, '[[ "$GITHUB_REF_NAME" == v*-rc.* ]]');
  assert.equal(workflow.jobs.prod.if, "${{ !contains(github.ref_name, '-rc.') }}");
  assert.match(workflow.jobs.prod.steps[0].run, /^\[\[ "\$\{GITHUB_REF_NAME,,\}" != \*-rc\.\* \]\] \|\| \{ [^\n]*; exit 1; \}$/mu);
});

test("stable promotion requires a published prerelease and a successful release run for the same commit", async () => {
  const { jobs } = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const name = "Require a successful release candidate for this commit";
  const index = jobs.prod.steps.findIndex(step => step.name === name);
  assert(index > 0 && index < jobs.prod.steps.findIndex(step => step.uses?.startsWith("docker/login-action@")));
  assert(!jobs.stg.steps.some(step => step.name === name));
  const step = jobs.prod.steps[index];
  assert.equal(step.env.GH_TOKEN, "${{ github.token }}");

  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const commit = "a".repeat(40);
  const candidate = "v1.2.3-rc.1";
  const missing = "No successful published v*-rc.* release for this commit";
  const fixture = String.raw`
git() {
  case "$*" in
    'rev-parse HEAD') printf '%s\n' "$FIXTURE_COMMIT" ;;
    "ls-remote --exit-code origin refs/tags/$FIXTURE_RC refs/tags/$FIXTURE_RC^{}")
      printf '%s\trefs/tags/%s^{}\n' "$FIXTURE_TAG_COMMIT" "$FIXTURE_RC" ;;
    *) return 2 ;;
  esac
}
gh() {
  case "$1 $2" in
    'api --method')
      [[ "$*" == "api --method GET --paginate repos/$GITHUB_REPOSITORY/actions/workflows/release.yml/runs -f event=push -f status=success -f head_sha=$FIXTURE_COMMIT -F per_page=100 --jq .workflow_runs[].head_branch // empty" ]] || return 2
      printf '%s\n' "$FIXTURE_TAGS"
      return "$FIXTURE_API_STATUS"
      ;;
    'release view')
      [[ "$*" == "release view $FIXTURE_RC --repo $GITHUB_REPOSITORY --json isDraft,isPrerelease --jq .isDraft == false and .isPrerelease == true" ]] || return 2
      printf '%s\n' "$FIXTURE_PUBLISHED"
      return "$FIXTURE_RELEASE_STATUS"
      ;;
    *) return 2 ;;
  esac
}
`;
  const scenarios = [
    { label: "published RC with an annotated tag", tags: `v1.2.2\n${candidate}` },
    { label: "no successful RC run", tags: "v1.2.2", error: missing },
    { label: "tag points to a different commit", tagCommit: "b".repeat(40), error: missing },
    { label: "release is a draft or is not a prerelease", published: "false", error: missing },
    { label: "release lookup failed", releaseStatus: "1", error: missing },
    { label: "run lookup failed", apiStatus: "1", error: "Could not verify successful release candidate workflow runs" },
  ];
  for (const { label, tags = candidate, tagCommit = commit, published = "true", apiStatus = "0", releaseStatus = "0", error } of scenarios) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", "-c", fixture + step.run], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: {
        ...process.env, GITHUB_REPOSITORY: "fixture/release", FIXTURE_RC: candidate, FIXTURE_COMMIT: commit,
        FIXTURE_TAGS: tags, FIXTURE_TAG_COMMIT: tagCommit, FIXTURE_PUBLISHED: published,
        FIXTURE_API_STATUS: apiStatus, FIXTURE_RELEASE_STATUS: releaseStatus,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, error ? 1 : 0, `${label}\n${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.trim(), error ? `::error::${error}` : "", label);
  }
});
