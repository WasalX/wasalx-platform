import {requiredOperatorInput} from "./operator-input.mjs";
import assert from "node:assert/strict";

export const CI_ONLY_REF_SOURCE = "refs/heads/wasalx/ci-only-[a-z0-9][a-z0-9._-]*";
export const CI_ONLY_REF = new RegExp(`^${CI_ONLY_REF_SOURCE}$`, "u");
const qualityWorkflow = () => ("WasalX/WasalX/" + requiredOperatorInput("WASALX_QUALITY_WORKFLOW_PATH"));

export function validateManagedIdentity(environment) {
  assert.equal(environment.GITHUB_EVENT_NAME, "workflow_dispatch", "managed runtime is owner-dispatch only");
  assert.equal(environment.GITHUB_REPOSITORY, "WasalX/WasalX");
  assert.equal(environment.GITHUB_REF_PROTECTED, "false", "managed runtime cannot qualify protected contexts");
  const ref = environment.GITHUB_REF ?? "";
  const ciOnly = CI_ONLY_REF.test(ref);
  assert.equal(environment.GITHUB_WORKFLOW_REF,
    `${qualityWorkflow()}@${ciOnly ? ref : "refs/heads/integration/wasalx"}`);
  assert.match(environment.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(environment.WASALX_CI_RUNTIME_SHA, environment.GITHUB_SHA);
  if (ciOnly) {
    assert.equal(environment.WASALX_CI_SCOPE, "full", "CI-only managed runtime requires full scope");
    assert.equal(environment.WASALX_CI_ROUTE, "cloud", "CI-only managed runtime requires cloud route");
    assert.equal(environment.WASALX_CI_EVIDENCE_MODE, "non-qualifying-ci-only", "CI-only managed runtime is non-qualifying");
  } else {
    assert.equal(ref, "refs/heads/integration/wasalx", "qualifying managed runtime requires integration/wasalx");
  }
  return { ref, ciOnly };
}

export const cloudSelector = { group: "example-runtime", labels: ["self-hosted", "example-runtime", "example-runtime", "example-runtime"] };
export const fullruntimeSelector = ["self-hosted", "linux", "x64", "example-runtime", "example-runtime"];
export const publisherSelector = { group: "example-runtime", labels: "example-runtime" };
const controlJobs = new Set(["qualification-admission", "queue-liveness", "browser-result"]);
const serverFallbackControlJobs = new Set(["qualification-admission", "browser-result"]);
const jobs = new Set([...controlJobs, "repository", "postgres", "browser-shards", "browser", "infrastructure", "docker-smoke", "zammad-compatibility", "local-release-ready", "publish-manifest"]);

export function validateCiOnlyIdentity(environment, context) {
  const ref = environment.GITHUB_REF ?? "";
  if (!CI_ONLY_REF.test(ref)) return { ref, ciOnly: false, smokeOnly: false };
  assert.equal(environment.GITHUB_EVENT_NAME, "workflow_dispatch", "CI-only runtime is dispatch-only");
  assert.equal(environment.GITHUB_REPOSITORY, "WasalX/WasalX");
  assert.equal(environment.GITHUB_REF_PROTECTED, "false", "CI-only runtime cannot qualify protected contexts");
  assert.equal(environment.GITHUB_WORKFLOW_REF, `${qualityWorkflow()}@${ref}`);
  assert.match(environment.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(environment.WASALX_CI_RUNTIME_SHA, environment.GITHUB_SHA);
  assert.equal(environment.WASALX_CI_SCOPE, "full", "CI-only runtime requires full scope");
  assert.equal(environment.WASALX_CI_EVIDENCE_MODE, "non-qualifying-ci-only", "CI-only runtime is non-qualifying");
  assert.equal(environment.WASALX_CI_RUN_BROWSER, "false", "CI-only runtime requires browser=false");
  assert(["true", "false"].includes(environment.WASALX_CI_RUN_DOCKER_SMOKE), "CI-only Docker switch is invalid");
  const smokeOnly = context.job === "docker-smoke";
  if (smokeOnly) {
    assert.equal(environment.WASALX_CI_RUN_DOCKER_SMOKE, "true", "docker-smoke requires its input enabled");
    assert.equal(context.route, "fullruntime", "CI-only docker-smoke requires fullruntime");
  } else assert.equal(context.route, "cloud", "CI-only non-smoke jobs require cloud");
  return { ref, ciOnly: true, smokeOnly };
}

export function validateCiExecutionContext(context, expectedJob) {
  assert(context && typeof context === "object", "Missing CI execution context");
  assert.deepEqual(Object.keys(context).sort(), ["WASALX_CI_RUNTIME", "job", "route", "scope", "selector"], "Incomplete CI execution context");
  assert(["native", "managed"].includes(context.WASALX_CI_RUNTIME) && ["cloud", "fullruntime", "publisher"].includes(context.route)
    && ["full", "repository-only"].includes(context.scope) && jobs.has(context.job), "Unknown CI execution context");
  if (expectedJob !== undefined) assert.equal(context.job, expectedJob, "CI execution context belongs to another job");
  if (context.job === "publish-manifest") assert.equal(context.route, "publisher", "Release evidence requires the isolated publisher route");
  else assert.notEqual(context.route, "publisher", "Publisher route belongs to release evidence");
  if (controlJobs.has(context.job) && !serverFallbackControlJobs.has(context.job))
    assert.equal(context.route, "cloud", "Control jobs require their cloud route");
  const selector = context.route === "publisher" ? publisherSelector : context.route === "fullruntime" ? fullruntimeSelector
    : controlJobs.has(context.job) ? { group: "example-runtime", labels: ["self-hosted", "example-runtime", "example-runtime", "example-runtime"] } : cloudSelector;
  assert.deepEqual(context.selector, selector, "CI selector contradicts its route");
  if (context.WASALX_CI_RUNTIME === "managed") {
    assert(["repository", "infrastructure"].includes(context.job) && context.route === "cloud", "Managed CI runtime requires the cloud repository or Dockerless infrastructure route");
  } else if (context.job === "repository") {
    assert.equal(context.route, "fullruntime", "Native CI repository requires the fullruntime route");
  }
  if (context.scope === "repository-only") {
    assert(context.job === "repository" && context.WASALX_CI_RUNTIME === "managed", "Bounded CI scope requires managed repository execution");
  }
  return context;
}

export function ciExecutionContext(environment) {
  const context = { WASALX_CI_RUNTIME: environment.WASALX_CI_RUNTIME, route: environment.WASALX_CI_ROUTE,
    selector: JSON.parse(environment.WASALX_CI_SELECTOR ?? "null"), job: environment.GITHUB_JOB, scope: environment.WASALX_CI_SCOPE };
  validateCiExecutionContext(context);
  validateCiOnlyIdentity(environment, context);
  return context;
}

export function infrastructureToolMode(environment) {
  if (environment.GITHUB_JOB !== "infrastructure") return undefined;
  return environment.WASALX_CI_RUNTIME === "managed" && environment.WASALX_CI_ROUTE === "cloud" ? "native" : "docker";
}

export function validateCiEvidence(record, expectedJob) {
  const context = validateCiExecutionContext(record.executionContext, expectedJob);
  assert.equal(record.runnerPool, context.WASALX_CI_RUNTIME, "CI runner pool contradicts execution context");
  assert.equal(record.qualificationScope === undefined ? "full" : record.qualificationScope, context.scope, "CI qualification scope contradicts execution context");
  if (record.evidenceMode !== undefined)
    assert(["non-qualifying-ci-only", "non-qualifying-inputs-disabled"].includes(record.evidenceMode), "Unknown CI evidence mode");
  if (record.evidenceMode === "non-qualifying-ci-only") {
    assert.match(record.ref ?? "", CI_ONLY_REF, "CI-only evidence ref is missing or invalid");
    assert.equal(record.workflowRef, `${qualityWorkflow()}@${record.ref}`, "CI-only evidence workflow ref is invalid");
    if (context.job === "docker-smoke") assert.equal(context.route, "fullruntime", "Docker smoke evidence requires fullruntime");
    else assert.equal(context.route, "cloud", "Non-smoke CI-only evidence requires cloud");
  }
  return context;
}
