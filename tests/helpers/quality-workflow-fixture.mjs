import "./operator-input-fixtures.mjs";
import { runInNewContext } from "node:vm";

export const qualityCloud = { group: "example-runtime", labels: ["self-hosted", "example-runtime", "example-runtime", "example-runtime"] };
export const qualityFullRuntime = ["self-hosted", "linux", "x64", "example-runtime", "example-runtime"];
export const qualityControl = { group: "example-runtime", labels: ["self-hosted", "example-runtime", "example-runtime", "example-runtime"] };

const nativeWorkflowRef = ("WasalX/WasalX/" + process.env.WASALX_QUALITY_WORKFLOW_PATH + "@refs/heads/integration/wasalx");

const fixtureEnvironmentKeys = ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "NODE_OPTIONS", "PNPM_HOME", "COREPACK_HOME", "WASALX_NODE_BIN"];

export function fixtureEnvironment(overrides = {}) {
  const environment = Object.fromEntries(fixtureEnvironmentKeys
    .filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]));
  return { ...environment, ...overrides };
}

export function qualityJobName(job, matrix = Object.fromEntries(Object.entries(job.strategy?.matrix ?? {}).map(([key, values]) => [key, values[0]]))) {
  return job.name.replace(/\$\{\{(.*?)\}\}/gu, (_, expression) => runInNewContext(expression, { matrix }));
}

export function qualityRunner(job, needs = {}, vars = {}, github = { event_name: "push" }) {
  const selector = job["runs-on"];
  if (typeof selector !== "string" || !selector.startsWith("${{")) return selector;
  const expression = selector.slice(3, -2).replace(/\.([\w]+-[\w-]+)/gu, (_, key) => `[${JSON.stringify(key)}]`);
  const expressionVars = { ...vars };
  if (typeof expressionVars.WASALX_CI_CONTROL_ROUTE === "string")
    expressionVars.WASALX_CI_CONTROL_ROUTE = expressionVars.WASALX_CI_CONTROL_ROUTE.toLowerCase();
  const value = runInNewContext(expression, {
    matrix: Object.fromEntries(Object.entries(job.strategy?.matrix ?? {}).map(([key, values]) => [key, values[0]])),
    needs: { ...needs, "qualification-admission": { outputs: {}, ...(needs["qualification-admission"] ?? { result: "success" }) } },
    github: { event_name: github.event_name ?? "push" }, inputs: {}, vars: expressionVars, fromJSON: JSON.parse,
  });
  return JSON.parse(JSON.stringify(value));
}

export function nativeEnvironment(job) {
  return { GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: "WasalX/WasalX", GITHUB_REF: "refs/heads/integration/wasalx",
    GITHUB_REF_NAME: "integration/wasalx", GITHUB_REF_PROTECTED: "false", GITHUB_WORKFLOW_REF: nativeWorkflowRef,
    GITHUB_JOB: job, WASALX_CI_RUNTIME: "native", WASALX_CI_ROUTE: "fullruntime",
    WASALX_CI_SELECTOR: JSON.stringify(qualityFullRuntime), WASALX_CI_SCOPE: "full" };
}

export function nativeExecutionContext(job) {
  return { WASALX_CI_RUNTIME: "native", route: "fullruntime", selector: qualityFullRuntime, job, scope: "full" };
}

export const managedEnvironment = {
  WASALX_CI_ROUTE: "cloud", WASALX_CI_SELECTOR: JSON.stringify(qualityCloud),
  WASALX_CI_WORKFLOW_RUNTIME: "native",
  WASALX_CI_SELECTOR_CLOUD: '{"group":"example-runtime","labels":["self-hosted","example-runtime","example-runtime","example-runtime"]}',
  WASALX_CI_SELECTOR_FULLRUNTIME: '["self-hosted","linux","x64","example-runtime","example-runtime"]',
  WASALX_CI_SELECTOR_CONTROL: '{"group":"example-runtime","labels":["self-hosted","example-runtime","example-runtime","example-runtime"]}',
  WASALX_CI_REPOSITORY_ROUTE: "cloud",
  WASALX_CI_POSTGRES_ROUTE: "fullruntime",
  WASALX_CI_BROWSER_ROUTE: "fullruntime",
  WASALX_CI_SCOPE: "full",
  WASALX_CI_RUNTIME: "managed", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "WasalX/WasalX", GITHUB_REF: "refs/heads/integration/wasalx", GITHUB_REF_NAME: "integration/wasalx", GITHUB_REF_PROTECTED: "false",
  GITHUB_WORKFLOW_REF: ("WasalX/WasalX/" + process.env.WASALX_QUALITY_WORKFLOW_PATH + "@refs/heads/integration/wasalx"),
  RUNNER_ENVIRONMENT: "self-hosted", RUNNER_OS: "Linux", GITHUB_SHA: "a".repeat(40), WASALX_CI_RUNTIME_SHA: "a".repeat(40),
  WASALX_CI_CPU_TRIAL_LIVE: "false", WASALX_CI_APPLICATION_CPUS: "", WASALX_CI_RUN_BROWSER: "false", WASALX_CI_RUN_DOCKER_SMOKE: "false", GITHUB_JOB: "repository",
  GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", CI_UNIT_WORKERS_CLOUD: "3",
};
