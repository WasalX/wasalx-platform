const steps = new Set([
  "Navigate to platform tenants",
  "Find tenant row",
  "Open transition dialog",
  "Select transition plan",
  "Read transition review",
  "Select statement version",
  "Check transition console",
  "Check revoked transition authority",
  "Select alternate plan while review is held",
  "Check controls after late review",
  "Check controls after pending plan removal",
]);

const counts = new Set([
  "transitionReads", "transitionWrites", "deniedReads", "authorityPlanOptions",
  "lateReviewButtons", "remainingPlanOptions", "pendingExpectedConsole", "unexpectedConsole",
]);
const metricPrefix = "wasalx-operator:";

export function operatorCaseProgress(test, result) {
  let lastCompletedStep;
  let terminalStep;
  for (const step of result?.steps ?? []) {
    if (!steps.has(step.title)) continue;
    if (step.error || step.duration < 0) {
      terminalStep = step.title;
      break;
    }
    if (Number.isFinite(step.duration)) lastCompletedStep = step.title;
  }
  const observations = {};
  for (const { type, description } of [...(test.annotations ?? []), ...(result?.annotations ?? [])]) {
    if (typeof type !== "string" || !type.startsWith(metricPrefix) ||
        typeof description !== "string" || !/^[0-9]{1,4}$/u.test(description)) continue;
    const name = type.slice(metricPrefix.length);
    const value = Number(description);
    if (counts.has(name) || (name === "authorityStatus" && value === 403)) observations[name] = value;
  }
  return { lastCompletedStep, terminalStep, observations };
}
