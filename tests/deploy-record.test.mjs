import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflowFile = new URL("../.github/workflows/deploy.yml", import.meta.url);
const manifestHelper = new URL("../scripts/release/image-manifest.sh", import.meta.url);

test("deploy records only manifests admitted by the selected environment", async () => {
  const [source, helper] = await Promise.all([
    readFile(workflowFile, "utf8"),
    readFile(manifestHelper, "utf8"),
  ]);
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const { environment, ref } = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["environment", "ref"]);
  assert.equal(environment.type, "choice");
  assert.equal(environment.required, true);
  assert.deepEqual(environment.options, ["dev", "stg", "prod"]);
  assert.equal(ref.type, "string");
  assert.equal(ref.required, true);

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["record"]);
  const job = workflow.jobs.record;
  assert.equal(job.environment, "${{ inputs.environment }}");
  assert.deepEqual(job.permissions, { actions: "read", contents: "read" });
  assert.doesNotMatch(source, /\benvironment_url\b/u);

  const [step] = job.steps.filter(({ run }) => run);
  assert.deepEqual(step.env, {
    GH_TOKEN: "${{ github.token }}",
    DEPLOY_ENVIRONMENT: "${{ inputs.environment }}",
    DEPLOY_REF: "${{ inputs.ref }}",
  });
  assert.doesNotMatch(step.run, /\$\{\{/u);
  assert.match(step.run, /dev\)\s+\[\[ "\$DEPLOY_REF" =~ \^\[0-9a-fA-F\]\{40\}\$ \]\]/u);
  assert.match(step.run, /stg\|prod\)\s+\[\[ "\$DEPLOY_REF" =~ \^v\[A-Za-z0-9_\.-\]\{0,127\}\$ \]\]/u);
  assert.match(step.run, /if \[\[ "\$DEPLOY_ENVIRONMENT" == stg \]\]; then\s+\[\[ "\$DEPLOY_REF" == v\*-rc\.\* \]\]/u);
  assert.match(step.run, /else\s+\[\[ "\$\{DEPLOY_REF,,\}" != \*-rc\.\* \]\].*exit 1/u);
  assert.match(step.run, /\[\[ "\$GITHUB_REF" == "refs\/tags\/\$DEPLOY_REF" \]\]/u);
  assert.match(step.run, /require_tag_commit "\$GITHUB_REF" "\$commit"\s+gh release download "\$DEPLOY_REF" .*--pattern images-manifest\.json/u);
  assert.match(step.run, /download_main_image_manifest "\$commit" "\$directory"/u);
  assert.match(helper, /compare\/\$commit\.\.\.main/u);
  assert.match(helper, /--workflow ci\.yml --branch main[^\n]*\n\s*--event push --commit "\$commit" --status success/u);
  assert.match(helper, /\.name == "publish \/ Image digest manifest" and \.conclusion == "success"/u);
  assert.match(helper, /gh run download "\$run" .*--name images-manifest/u);
  assert.match(step.run, /select\(\.commit == \$commit\) \| \.images \| to_entries\[\]/u);
  assert.match(step.run, />> "\$GITHUB_STEP_SUMMARY"/u);
});

test("deploy validation executes refusals and records valid manifests", async t => {
  const workflow = parse(await readFile(workflowFile, "utf8"));
  const step = workflow.jobs.record.steps.find(({ name }) => name === "Validate ref and record image digests");
  const directory = await mkdtemp(join(tmpdir(), "wasalx-deploy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const options = { cwd: directory, env, encoding: "utf8", timeout: 10_000, windowsHide: true };
  const git = (...args) => {
    const result = spawnSync("git", args, options);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const release = "v1.2.3";
  const rc = "v1.2.3-rc.1";
  git("init", "--quiet", "--template=");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  git("tag", release);
  git("tag", rc);
  git("remote", "add", "origin", ".");

  const digest = `sha256:${"a".repeat(64)}`;
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, "scripts", "release"), { recursive: true });
  await Promise.all([
    copyFile(manifestHelper, join(directory, "scripts", "release", "image-manifest.sh")),
    writeFile(join(directory, "validate.sh"), step.run),
    writeFile(join(directory, "fixture-env"), 'export PATH="$PWD/bin:$PATH"\n'),
    writeFile(join(directory, "manifest.json"), JSON.stringify({ commit, images: { portal: { digest } } })),
    writeFile(join(directory, "bin", "gh"), String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> gh-calls
case "$1 $2" in
  'api repos/fixture/deploy-record/compare/${commit}...main') echo identical ;;
  'run list') echo 123 ;;
  'run view') echo 1 ;;
  'run download'|'release download')
    while [[ "$1" != --dir ]]; do shift; done
    cp manifest.json "$2/images-manifest.json"
    ;;
  *) echo 'Unexpected gh call' >&2; exit 2 ;;
esac
`, { mode: 0o755 }),
  ]);

  const summary = join(directory, "summary");
  const ghCalls = join(directory, "gh-calls");
  const main = "refs/heads/main";
  const tag = ref => `refs/tags/${ref}`;
  const semicolon = "v1;touch semicolon-marker";
  const substitution = "v1$(touch substitution-marker)";
  const scenarios = [
    ["prod refuses an RC tag", "prod", rc, tag(rc), "Production refuses release candidate tags"],
    ["prod refuses an uppercase RC tag", "prod", "v1.2.3-RC.1", tag("v1.2.3-RC.1"), "Production refuses release candidate tags"],
    ["prod refuses dispatch from main", "prod", release, main, "Dispatch from the requested tag"],
    ["prod refuses a mismatched dispatch tag", "prod", release, tag(rc), "Dispatch from the requested tag"],
    ["stg refuses a final release tag", "stg", release, tag(release), "Staging requires a release candidate tag"],
    ["prod refuses a shell separator in the ref", "prod", semicolon, tag(semicolon), "Expected a release tag"],
    ["prod refuses command substitution in the ref", "prod", substitution, tag(substitution), "Expected a release tag"],
    ["dev refuses a non-hex SHA", "dev", "g".repeat(40), main, "DEV requires a 40-hex commit SHA"],
    ["dev refuses dispatch from a feature branch", "dev", commit, "refs/heads/feature", "Dispatch DEV from main"],
    ["deploy refuses an empty environment", "", commit, main, "Unknown deployment environment"],
    ["deploy refuses an unknown environment", "qa", commit, main, "Unknown deployment environment"],
    ["dev records a main commit", "dev", commit.toUpperCase(), main],
    ["stg records a release candidate", "stg", rc, tag(rc)],
    ["prod records a final release", "prod", release, tag(release)],
  ];

  for (const [name, environment, ref, dispatchRef, refusal] of scenarios) {
    await t.test(name, async () => {
      await Promise.all([writeFile(summary, ""), writeFile(ghCalls, "")]);
      const result = spawnSync(bash, ["--noprofile", "--norc", "-euo", "pipefail", "validate.sh"], {
        ...options,
        env: {
          ...env,
          BASH_ENV: "./fixture-env",
          DEPLOY_ENVIRONMENT: environment,
          DEPLOY_REF: ref,
          GITHUB_REF: dispatchRef,
          GITHUB_REPOSITORY: "fixture/deploy-record",
          GITHUB_STEP_SUMMARY: "summary",
          GIT_TRACE: "1",
          GH_TOKEN: "fixture",
          RUNNER_TEMP: ".",
        },
      });
      assert.ifError(result.error);
      const diagnostic = result.stdout + result.stderr;
      const recorded = await readFile(summary, "utf8");
      if (refusal) {
        assert.ok(result.status > 0, diagnostic);
        assert.ok(diagnostic.split(/\r?\n/u).includes(`::error::${refusal}`), diagnostic);
        assert.equal(await readFile(ghCalls, "utf8"), "");
        assert.doesNotMatch(result.stderr, /\btrace: /u, "Git must not run before refusal");
        assert.equal(recorded, "");
        assert.equal(existsSync(join(directory, "semicolon-marker")), false);
        assert.equal(existsSync(join(directory, "substitution-marker")), false);
      } else {
        assert.equal(result.status, 0, diagnostic);
        assert.equal(recorded, `### Image digests for \`${ref}\` (${environment})\n\nSource commit \`${commit}\`\n\n- \`portal\` \`${digest}\`\n`);
      }
    });
  }
});
