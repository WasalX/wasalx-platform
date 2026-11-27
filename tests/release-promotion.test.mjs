import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const { jobs } = workflow;
  const preflight = jobs["stable-preflight"];
  assert.deepEqual(Object.keys(jobs).sort(), ["prod", "stable-preflight", "stg"]);
  assert(!Object.hasOwn(preflight, "environment"));
  assert.deepEqual(preflight.permissions, { actions: "read", contents: "read" });
  assert.equal(jobs.prod.needs, "stable-preflight");
  assert(!Object.hasOwn(jobs.stg, "needs"));
  const commands = [script, helper, ...preflight.steps.map(step => step.run ?? "")];
  for (const name of ["prod", "stg"]) {
    const job = jobs[name];
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
  assert.equal(jobs.stg.if, "${{ github.repository == 'WasalX/wasalx-platform' && contains(github.ref_name, '-rc.') }}");
  assert.equal(jobs.stg.steps[0].run, '[[ "$GITHUB_REF_NAME" == v*-rc.* ]]');
  assert.equal(jobs.prod.if, "${{ !contains(github.ref_name, '-rc.') }}");
  assert.equal(preflight.if, jobs.prod.if);
  assert.match(preflight.steps[0].run, /^\[\[ "\$\{GITHUB_REF_NAME,,\}" != \*-rc\.\* \]\] \|\| \{ [^\n]*; exit 1; \}$/mu);
});

test("release promotion verifies the registry's exact manifest bytes", () => {
  const bash =
    process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const image = "registry.example/fixture/worker";
  const tag = "v1.2.3-rc.1";
  const manifest =
    '{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json"}';
  const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  const fixture = String.raw`
source() { [[ "$1" == scripts/release/image-manifest.sh ]]; }
git() { printf 'fixture-commit\n'; }
require_tag_commit() { :; }
mktemp() { printf 'fixture-directory\n'; }
download_main_image_manifest() { :; }
cosign() { :; }
python3() { :; }
jq() {
  case "$2" in
    '.linuxAmd64Sha256') printf 'fixture-pin\n' ;;
    '.images[].pullReference') printf '%s@%s\n' "$FIXTURE_IMAGE" "$FIXTURE_DIGEST" ;;
    *) return 2 ;;
  esac
}
sha256sum() {
  if [[ "$*" == '--check --strict' ]]; then cat >/dev/null; else command sha256sum "$@"; fi
}
docker() {
  local alias="$FIXTURE_IMAGE:$GITHUB_REF_NAME"
  case "$*" in
    "buildx imagetools create --prefer-index=false --tag $alias $FIXTURE_IMAGE@$FIXTURE_DIGEST") ;;
    "buildx imagetools inspect --format {{.Manifest.Digest}} $alias")
      printf 'Name: %s\nMediaType: application/vnd.docker.distribution.manifest.v2+json\nDigest: %s\n' "$alias" "$FIXTURE_DIGEST"
      ;;
    "buildx imagetools inspect --raw $alias") printf '%s' "$FIXTURE_MANIFEST" ;;
    *) return 2 ;;
  esac
}
gh() {
  case "$1 $2" in
    'release view') printf 'release not found\n'; return 1 ;;
    'release create') printf 'prerelease created\n' ;;
    *) return 2 ;;
  esac
}
builtin source scripts/release/promote-tag.sh
`;
  for (const bytes of [manifest, `${manifest}\n`]) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", fixture], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "WasalX/wasalx-platform",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: `refs/tags/${tag}`,
        GITHUB_REF_NAME: tag,
        RUNNER_TEMP: "fixture-temp",
        FIXTURE_IMAGE: image,
        FIXTURE_DIGEST: digest,
        FIXTURE_MANIFEST: bytes,
      },
    });
    assert.ifError(result.error);
    if (bytes === manifest) {
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.equal(result.stdout.trim(), "prerelease created");
    } else {
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      assert.equal(
        result.stdout.trim(),
        `::error::Digest mismatch for ${image}:${tag} (expected ${digest}, got ${actual})`,
      );
    }
  }
});

test("stable release preflight requires successful main CI and a published RC for the same commit", async () => {
  const { jobs } = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const name = "Verify main CI and the prior release candidate";
  const step = jobs["stable-preflight"].steps.find(step => step.name === name);
  assert(![...jobs.stg.steps, ...jobs.prod.steps].some(step => step.name === name));
  assert.equal(step.env.GH_TOKEN, "${{ github.token }}");

  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const commit = "a".repeat(40);
  const candidate = "v1.2.3-rc.1";
  const stable = "v1.2.3";
  const missing = "No successful published v*-rc.* release for this commit";
  const missingCI = "No verified successful main CI push run for this commit";
  const fixture = String.raw`
git() {
  case "$*" in
    'rev-parse HEAD') printf '%s\n' "$FIXTURE_COMMIT" ;;
    "ls-remote --exit-code origin refs/tags/$FIXTURE_TAG refs/tags/$FIXTURE_TAG^{}")
      printf '%s\trefs/tags/%s^{}\n' "$FIXTURE_TAG_COMMIT" "$FIXTURE_TAG" ;;
    *) return 2 ;;
  esac
}
gh() {
  case "$1 $2" in
    'run list')
      [[ "$*" == "run list --repo $GITHUB_REPOSITORY --workflow ci.yml --branch main --event push --commit $FIXTURE_COMMIT --status success --limit 1 --json databaseId --jq .[0].databaseId // empty" ]] || return 2
      printf '%s\n' "$FIXTURE_CI_RUN"
      return "$FIXTURE_CI_STATUS"
      ;;
    'api --method')
      [[ "$*" == "api --method GET --paginate repos/$GITHUB_REPOSITORY/actions/workflows/release.yml/runs -f event=push -f status=success -f head_sha=$FIXTURE_COMMIT -F per_page=100 --jq .workflow_runs[].head_branch // empty" ]] || return 2
      printf '%s\n' "$FIXTURE_TAGS"
      return "$FIXTURE_API_STATUS"
      ;;
    'release view')
      [[ "$*" == "release view $FIXTURE_TAG --repo $GITHUB_REPOSITORY --json isDraft,isPrerelease --jq .isDraft == false and .isPrerelease == true" ]] || return 2
      printf '%s\n' "$FIXTURE_PUBLISHED"
      return "$FIXTURE_RELEASE_STATUS"
      ;;
    *) return 2 ;;
  esac
}
`;
  const scenarios = [
    { label: "published RC with an annotated tag", tags: `${stable}\n${candidate}` },
    { label: "no successful main CI push run", ciRun: "", error: missingCI },
    { label: "main CI lookup failed", ciStatus: "1", error: missingCI },
    { label: "no successful RC run", tags: "", error: missing },
    { label: "non-RC tag with a published prerelease", tags: stable, releaseTag: stable, error: missing },
    { label: "tag points to a different commit", tagCommit: "b".repeat(40), error: missing },
    { label: "release is a draft or is not a prerelease", published: "false", error: missing },
    { label: "release lookup failed", releaseStatus: "1", error: missing },
    { label: "run lookup failed", apiStatus: "1", error: "Could not verify successful release candidate workflow runs" },
  ];
  for (const {
    label, tags = candidate, releaseTag = candidate, tagCommit = commit, published = "true",
    ciRun = "123", ciStatus = "0", apiStatus = "0", releaseStatus = "0", error,
  } of scenarios) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", "-c", fixture + step.run], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: {
        ...process.env, GITHUB_REPOSITORY: "fixture/release", FIXTURE_TAG: releaseTag, FIXTURE_COMMIT: commit,
        FIXTURE_TAGS: tags, FIXTURE_TAG_COMMIT: tagCommit, FIXTURE_PUBLISHED: published,
        FIXTURE_CI_RUN: ciRun, FIXTURE_CI_STATUS: ciStatus, FIXTURE_API_STATUS: apiStatus, FIXTURE_RELEASE_STATUS: releaseStatus,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, error ? 1 : 0, `${label}\n${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.trim(), error ? `::error::${error}` : "", label);
  }
});
