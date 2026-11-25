import { appendFileSync } from "node:fs";

export const title = "operator cost drafts, accepted activation and every bounded reassessment page remain reachable";
export const specName = "meta-cost-operator.spec.ts";
export const projects = ["desktop", "mobile-390"];
export const axeLines = [87, 112];
const statuses = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);
const checkpoints = new Map([
  [52, "tenant-row"], [54, "usage-dialog"], [57, "cost-management"],
  [67, "analysis-pagination-name"], [68, "reassessment-pagination-name"],
  [75, "tariff-preview"], [78, "preview-keyboard-focus"], [87, "preview-axe-assertion"],
  [90, "activation-control-removed"], [100, "last-effect-accessible-name"],
  [102, "last-effect-selector-write"], [104, "last-effect-clear-write"],
  [111, "reassessment-write-limit"], [112, "reassessment-axe-assertion"],
  [113, "viewport-width"],
]);

function sourceLine(location) {
  const file = location?.file?.replaceAll("\\", "/");
  const line = Number(location?.line);
  return file?.endsWith("/" + specName) && Number.isInteger(line) && line >= 32 && line <= 114
    ? line : undefined;
}

export function stackLine(value) {
  const match = /(?:^|[/\\])meta-cost-operator\.spec\.ts:(\d+):\d+/mu.exec(value ?? "");
  const line = Number(match?.[1]);
  return line >= 32 && line <= 114 ? line : undefined;
}

function action(title = "", category) {
  const known = [
    [/(?:^|\.)selectOption\b|^Select option\b/iu, "select-option"],
    [/(?:^|\.)setInputFiles\b|^Set input files\b/iu, "set-input-files"],
    [/(?:^|\.)click\b|^Click\b/iu, "click"],
    [/(?:^|\.)focus\b|^Focus\b/iu, "focus"],
    [/(?:^|\.)check\b|^Check\b/iu, "check"],
    [/(?:^|\.)press\b|^Press\b/iu, "key-press"],
    [/(?:^|\.)fill\b|^Fill\b/iu, "fill"],
    [/(?:^|\.)goto\b|^Navigate\b/iu, "navigate"],
    [/(?:^|\.)waitForResponse\b|^Wait for response\b/iu, "wait-for-response"],
    [/(?:^|\.)evaluate\b|^Evaluate\b/iu, "evaluate"],
    [/toHaveCount\b/u, "assert-count"],
    [/toBeVisible\b/u, "assert-visible"],
    [/toBeFocused\b/u, "assert-focus"],
    [/toBeChecked\b/u, "assert-checked"],
    [/toHaveAccessibleName\b/u, "assert-accessible-name"],
    [/toHaveCSS\b/u, "assert-style"],
    [/toContainText\b/u, "assert-text"],
    [/toEqual\b/u, "assert-equal"],
    [/axe include|No elements found for include/iu, "axe-scope"],
    [/timeout|timed out/iu, "timeout"],
  ];
  return known.find(([pattern]) => pattern.test(title))?.[1] ??
    ({ expect: "assertion", "test.step": "test-step", "pw:api": "browser-action" })[category] ??
    "unclassified";
}

function errorSignal(error) {
  const message = error.message ?? error.value ?? "";
  return {
    action: action(message.split("\n", 1)[0]),
    line: sourceLine(error.location) ?? stackLine(error.stack) ?? stackLine(message),
  };
}

function nestedSteps(steps) {
  return steps.flatMap(step => [...nestedSteps(step.steps), step]);
}

export default class MetaCostReporter {
  onTestEnd(test, result) {
    const project = test.parent.project()?.name;
    if (!projects.includes(project) || test.title !== title ||
        !test.location.file.replaceAll("\\", "/").endsWith("/" + specName) ||
        !statuses.has(result.status)) {
      throw new Error("Unexpected hosted Meta cost case");
    }
    const steps = nestedSteps(result.steps);
    const completed = steps.filter(step => step.duration >= 0 && !step.error && sourceLine(step.location));
    const checkpointsPassed = [...new Set(completed.filter(step => step.category === "expect")
      .map(step => checkpoints.get(sourceLine(step.location))).filter(Boolean))];
    const latest = completed.at(-1);
    const signals = [
      ...steps.filter(step => step.error || step.duration < 0).map(step => ({
        action: action(step.title, step.category),
        line: sourceLine(step.location) ?? (step.error ? errorSignal(step.error).line : undefined),
      })),
      ...[result.error, ...result.errors].filter(Boolean).map(errorSignal),
    ];
    const unique = values => [...new Map(values.map(item => [JSON.stringify(item), item])).values()];
    const located = unique(signals.filter(item => item.line));
    const failures = (located.length ? located : unique(signals)).slice(0, 6);
    const axe = result.attachments.filter(attachment => attachment.name === "qa-axe-incomplete" && attachment.body)
      .map(attachment => JSON.parse(attachment.body.toString("utf8")));
    const evidence = {
      locale: process.env.WASALX_E2E_LOCALE,
      project,
      status: result.status,
      checkpointsPassed,
      ...(latest && { lastCompleted: { action: action(latest.title, latest.category), line: sourceLine(latest.location) } }),
      ...(result.status !== "passed" && { failures }),
      axe,
    };
    appendFileSync(process.env.QA_META_COST_CASES, JSON.stringify(evidence) + "\n");
  }
}
