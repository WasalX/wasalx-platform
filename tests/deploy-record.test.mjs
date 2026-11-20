import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("deploy records only manifests admitted by the selected environment", async () => {
  const [source, helper] = await Promise.all([
    readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release/image-manifest.sh", import.meta.url), "utf8"),
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
