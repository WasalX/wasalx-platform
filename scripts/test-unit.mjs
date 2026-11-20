import "../tests/helpers/operator-input-fixtures.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { ciRuntime } from "./release/ci-browser-runtime.mjs";

export function unitRubyPrerequisite(execute = spawnSync, env = process.env) {
  const binding = env.WASALX_RUBY_BIN;
  const args = binding ? ["-rminitest", "-rrbconfig", "-e", "puts RUBY_VERSION; print RbConfig.ruby"] : ["-rminitest", "-e", "print RUBY_VERSION"];
  const result = execute("ruby", args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`Unit prerequisite requires Ruby with minitest on PATH: ${result.error?.code ?? result.signal ?? result.stderr?.trim() ?? result.status}`, { cause: result.error });
  }
  const [version, executable, ...extra] = result.stdout.split(/\r?\n/u);
  assert.match(version, /^\d+\.\d+\.\d+$/, "Ruby version readback is invalid");
  assert.equal(extra.length, 0, "Ruby prerequisite readback has extra fields");
  if (binding) assert.equal(executable, binding, "Unit Ruby differs from WASALX_RUBY_BIN");
  else assert.equal(executable, undefined, "Ruby version readback is invalid");
  return binding ? `${version} (${executable})` : version;
}

export function unitConcurrency(env = process.env) {
  if (ciRuntime(env) === "native") return 4;
  assert.equal(env.GITHUB_JOB, "repository");
  assert.match(env.CI_UNIT_WORKERS_CLOUD ?? "", /^[1-9][0-9]*$/u, "managed unit workers require the existing platform hint");
  const workers = Number(env.CI_UNIT_WORKERS_CLOUD);
  assert(Number.isSafeInteger(workers), "managed worker hint must be a safe integer");
  return Math.min(4, workers);
}

// Keep test inventory out of package.json so new tests preserve Docker dependency caches.
const unitInventory = ["tests/operator-input.test.mjs","tests/no-agent-instruction-files.test.mjs","tests/installer-hosted-images.test.mjs","tests/application-e2e-harness.test.mjs","tests/direct-derived-reload.test.mjs","tests/handoff-articles.test.mjs",["tests/meta-cost-dev-driver.test.mjs",784],"tests/meta-deletion-journey.test.mjs","tests/meta-open-window.test.mjs","tests/meta-terminal.test.mjs","tests/meta-transition-dev-driver.test.mjs","tests/portal-case-producers.test.mjs","tests/portal-rule-command-producers.test.mjs","tests/safe-retry.test.mjs","tests/simulation-cases-business.test.mjs","tests/simulation-command-stage.test.mjs",["tests/simulation-completed-review.test.mjs",865],"tests/simulation-connection-quality.test.mjs","tests/simulation-direct-completed-adoption.test.mjs","tests/simulation-direct-continuation.test.mjs","tests/simulation-direct-derived.test.mjs","tests/simulation-direct-quality.test.mjs","tests/simulation-email-fixtures.test.mjs","tests/simulation-email-review-regression.test.mjs","tests/simulation-email-routing-precondition.test.mjs","tests/simulation-email-stages.test.mjs","tests/simulation-first-group-phases.test.mjs","tests/simulation-full-suite-mappings.test.mjs","tests/simulation-gows-receipt-owner-ui.test.mjs","tests/simulation-group-rule-derived.test.mjs","tests/simulation-group-rule-quality.test.mjs","tests/simulation-group-rule-role-contexts.test.mjs","tests/simulation-handoff-fixture.test.mjs",["tests/simulation-handoff-retry.test.mjs",1298],"tests/simulation-identity-recovery.test.mjs","tests/simulation-import-rows.test.mjs","tests/simulation-invitation-remaining.test.mjs","tests/simulation-invitation-retry.test.mjs","tests/simulation-lifecycle-bootstrap.test.mjs","tests/simulation-lifecycle.test.mjs",["tests/simulation-manifest.test.mjs",12991],"tests/simulation-meta-completed-adoption.test.mjs","tests/simulation-meta-producer.test.mjs","tests/simulation-native-account-continuation.test.mjs","tests/simulation-native-business.test.mjs","tests/simulation-native-context-binding.test.mjs","tests/simulation-native-grants.test.mjs","tests/simulation-native-group.test.mjs","tests/simulation-native-history.test.mjs",["tests/simulation-native-isolation.test.mjs",766],"tests/simulation-native-mail-foundation.test.mjs","tests/simulation-native-remaining.test.mjs","tests/simulation-navigation-quality.test.mjs","tests/simulation-navigation.test.mjs","tests/simulation-owner-evidence.test.mjs","tests/simulation-platform-enrollment.test.mjs","tests/simulation-platform-quality.test.mjs","tests/simulation-portal-email-producers.test.mjs","tests/simulation-portal-groups.test.mjs","tests/simulation-portal-meta-bsuid-stage.test.mjs","tests/simulation-postgres-designation-stage.test.mjs","tests/simulation-provider-stages.test.mjs","tests/simulation-q04-adoption.test.mjs","tests/simulation-q05u-adoption.test.mjs","tests/simulation-q06w-adoption.test.mjs","tests/simulation-q076-adoption.test.mjs","tests/simulation-q083-continuation.test.mjs","tests/simulation-q085-continuation.test.mjs","tests/simulation-remaining-quality.test.mjs","tests/simulation-retained-meta-fixture.test.mjs","tests/simulation-retained-security-business.test.mjs","tests/simulation-review-fixture.test.mjs","tests/simulation-review-obligation.test.mjs","tests/simulation-rule-immutable.test.mjs","tests/simulation-rule-input-stage.test.mjs","tests/simulation-rule-preview.test.mjs","tests/simulation-rule-stages.test.mjs","tests/simulation-security-compiled-contexts.test.mjs","tests/simulation-sender-identity-boundary.test.mjs","tests/simulation-sender-stage.test.mjs","tests/simulation-session-producer.test.mjs","tests/simulation-session-quality.test.mjs","tests/simulation-session-rotation.test.mjs","tests/simulation-shared-readonly.test.mjs","tests/simulation-team-numbers.test.mjs","tests/simulation-team-observation-selection.test.mjs","tests/simulation-team-quality.test.mjs","tests/simulation-team-stages.test.mjs","tests/simulation-tenant-evidence.test.mjs","tests/simulation-workflow-business.test.mjs","tests/sites-private-demo-boundary.test.mjs","tests/synthetic-first-group-driver.test.mjs","tests/unread-settlement.test.mjs","tests/workflow-quality-sequence.test.mjs","tests/zammad-integration-contract.test.ts","tests/fetch-zammad-addon.test.mjs",["tests/corresponding-source-pin.test.mjs",712],"tests/deployment-image-verification.test.mjs","tests/simulation-module-dependencies.test.mjs","tests/simulation-portal-isolation.test.mjs","tests/simulation-portal-pinned-quality.test.mjs","tests/simulation-portal-operator.test.mjs","tests/simulation-private-native-read.test.mjs","tests/native-routing-fixture.test.mjs","tests/workspace-read-fixture.test.mjs","tests/native-routing-contract.test.ts","tests/native-routing-sync.test.mjs","tests/native-membership-observation.test.mjs","tests/bulk-toggle-errors.test.mjs","tests/simulation-direct-returning-native.test.mjs","tests/simulation-email-effect-budget.test.mjs","tests/simulation-native-agent-evidence.test.mjs","tests/simulation-native-business-contexts.test.mjs","tests/simulation-native-identity-contract.test.mjs","tests/simulation-native-nickname-surfaces.test.mjs","tests/simulation-retained-fixture.test.mjs","tests/simulation-smtp-files.test.mjs","tests/simulation-email-recipient-restore.test.mjs","tests/meta-privacy-outcome-driver.test.mjs","tests/meta-legacy-intent.test.ts","tests/meta-legacy-portal.test.ts","tests/meta-legacy-signup.test.ts","tests/meta-template-mapping.test.mjs","tests/meta-template-send.test.mjs","tests/meta-legacy-migration-contract.test.mjs","tests/meta-legacy-migration.test.mjs","tests/meta-legacy-runtime-capability.test.mjs","tests/meta-template-dev-driver.test.mjs","tests/meta-legacy-dev-driver.test.mjs","tests/meta-template-continuity.test.mjs","tests/meta-template-intent.test.ts","tests/meta-template-portal.test.ts","tests/meta-billing-policy-portal.test.ts","tests/meta-billing-policy-intent.test.ts","tests/meta-template-inventory.test.mjs","tests/meta-deletion.test.mjs","tests/keycloak-appearance.test.mjs",'tests/meta-transition-operator.test.mjs','tests/meta-transition-operator-intent.test.ts','tests/meta-transition-operator-portal.test.ts','tests/meta-account-transition-worker.test.mjs','tests/meta-account-transition-execution.test.mjs','tests/meta-transition-intent.test.ts',"tests/meta-add-access-activation.test.mjs","tests/meta-cost-statements.test.ts","tests/meta-cost-source.test.mjs","tests/meta-cost-statement-api.test.mjs","tests/meta-cost-source-portal.test.ts","tests/meta-cost-privacy.test.mjs","tests/migration-connection.test.mjs","tests/delivery-ticket-number.test.mjs","tests/operator-ui-behavior.test.ts","tests/agent-ticket-destination.test.ts","tests/plugin-operator-ui.test.mjs","tests/bounded-catalog-and-delivery-ui.test.mjs","tests/review-queue-presentation.test.mjs","tests/automation-ui-hardening.test.mjs","tests/api-boundary-safety.test.mjs","tests/operator-evidence-ui.test.mjs","tests/zammad-author-attribution.test.mjs","tests/public-copy-contract.test.mjs","tests/bot-action.test.ts","tests/bot-flow.test.ts","tests/ticket-event-flow.test.ts","tests/ticket-event-hooks.test.mjs","tests/workflow-graph.test.ts","tests/bot-flow-control-api.test.mjs","tests/client-routing.test.ts","tests/client-routing-control-api.test.mjs","tests/native-membership.test.mjs","tests/portal-workspace.test.mjs","tests/simulation-service-identity.test.mjs","tests/current-portal-stage-bindings.test.mjs","tests/service-access-contract.test.mjs","tests/simulation-portal-reply-browser.test.mjs","tests/simulation-portal-mail-journal.test.mjs","tests/admin-workspace-state.test.mjs","tests/admin-bridge-fixture.test.mjs",["tests/workspace-binary.test.mjs",616],"tests/tenant-service-privacy-admission.test.mjs","tests/routing-sync.test.ts","tests/direct-message-adapter.test.mjs","tests/meta-routing.test.mjs","tests/meta-routing-setup-journey.test.mjs","tests/meta-routing-fixture.test.mjs","tests/meta-routing-readback.test.mjs","tests/meta-thread-intent.test.ts","tests/direct-bot-processor.test.mjs","tests/direct-keep-open-native-intent.test.mjs","tests/direct-keep-open-controls.test.mjs","tests/terraform-production-contract.test.mjs","tests/ci-only-admission.test.mjs","tests/serve-storybook-static.test.mjs","tests/waha-outbound-safety.test.mjs","tests/workspace-provider-infra.test.mjs","tests/workspace-provider.test.mjs",["tests/workspace-configurator.test.mjs",11462],"tests/group-disclosure-delivery.test.mjs","tests/mailbox-tls-fixture-protocol.test.mjs","tests/mailbox-tls-fixture-prepare.test.mjs","tests/domain.test.ts","tests/literal-matcher.test.ts","tests/marketing-workspace.test.ts","tests/core.test.ts","tests/security-auth.test.ts","tests/redis-security.test.ts","tests/portal-session.test.ts","tests/portal-auth-hardening.test.ts","tests/portal-operational-ux.test.mjs","tests/invitation-acceptance-portal.test.mjs","tests/media.test.ts","tests/media-runtime.test.mjs","tests/outbound-media.test.mjs","tests/observability.test.ts",["tests/observability-runtime.test.mjs",628],"tests/schema-contract.test.ts","tests/connection-operations-schema.test.ts","tests/provider-status-fencing.test.mjs","tests/provider-retry-policy.test.mjs","tests/connection-auth-actions-schema.test.mjs","tests/runtime-role-hardening.test.ts","tests/durable-worker-scheduler.test.ts","tests/delivery-outcome-fencing.test.mjs","tests/delivery-receipts-quarantine.test.mjs","tests/delivery-content-permission.test.mjs","tests/prepare-zammad-typecheck.test.mjs","tests/zammad-rails-load.test.mjs","tests/zammad-agent-context.test.mjs","tests/infra-contract.test.ts","tests/native-compat-cleanup.test.mjs","tests/disaster-recovery.test.mjs","tests/live-contract-harness.test.mjs","tests/connector-worker.test.mjs","tests/message-mutation-pipeline.test.mjs","tests/waha-lifecycle-client.test.mjs","tests/connection-readiness.test.ts",["tests/waha-worker-capacity.test.mjs",18252],"tests/connection-operation-worker.test.mjs","tests/connection-lifecycle-control-api.test.mjs","tests/waha-authorization-actions.test.mjs","tests/connection-onboarding-portal.test.mjs","tests/meta-groups-adapter.test.mjs","tests/meta-groups-control-api.test.mjs","tests/meta-account-relation.test.mjs","tests/meta-signup.test.mjs","tests/meta-coexistence.test.mjs","tests/meta-signup-portal.test.mjs","tests/meta-signup-sdk.test.mjs","tests/meta-billing-diagnostic.test.mjs","tests/meta-account-policy.test.mjs","tests/meta-account-transition.test.mjs","tests/meta-billing-timestamp.test.mjs","tests/meta-runtime-provenance.test.mjs","tests/meta-credit-contract.test.mjs","tests/meta-managed-approval.test.mjs","tests/meta-managed-funding.test.mjs","tests/meta-managed-policy.test.mjs","tests/meta-groups-portal.test.mjs","tests/secret-cleanup-outbox.test.mjs","tests/dev-secret-sidecar.test.mjs","tests/rule-test-control-api.test.mjs","tests/rule-policy-preview.test.mjs","tests/fixture-policy-clone.test.mjs","tests/rule-test-portal.test.mjs","tests/rule-governance.test.mjs","tests/group-binding-control-api.test.mjs","tests/group-configuration-portal.test.mjs","tests/zammad-routing-catalog.test.mjs","tests/case-lifecycle.test.mjs","tests/zammad-participant-identity.test.mjs","tests/direct-return-repair.test.mjs","tests/delivery-review-repair.test.ts","tests/tenant-provisioning-runtime.test.mjs","tests/tenant-provisioner.test.mjs","tests/tenant-provisioner-infra.test.mjs","tests/tenant-workspace-controller.test.mjs","tests/invitation-mailer-runtime.test.mjs","tests/provision-invitee.test.mjs","tests/nodemailer-security.test.mjs","tests/identity-policy-activator.test.mjs","tests/privacy-retention-lifecycle.test.mjs","tests/privacy-portal-experience.test.mjs","tests/privacy-target-selection-ui.test.mjs","tests/platform-support-access.test.mjs","tests/platform-operations-metering.test.mjs","tests/platform-operator-portal.test.ts","tests/audit-export.test.mjs","tests/meta-cost.test.ts","tests/meta-cost-api.test.mjs","tests/meta-cost-portal.test.ts","tests/edge-runtime-isolation.test.mjs","tests/health-readiness.test.mjs","tests/fixture-role.test.mjs","tests/tenant-administration.test.mjs","tests/tenant-permissions-ssot.test.ts","tests/control-api.test.mjs","tests/meta-webhook-http.test.mjs","tests/image-size.test.mjs","tests/braces-patch.test.mjs","tests/braces-image-patch.test.mjs","tests/design-system-governance.test.mjs","tests/site-metadata.test.mjs","tests/shell-validation.test.ts","tests/client-routing-draft.test.ts","tests/automation-coverage-bridge.test.mjs","tests/zammad-assets-smoke.test.mjs","tests/promotion-source.test.mjs","tests/deploy-record.test.mjs",
  "tests/automation-cases-i18n.test.mjs",
  "tests/bundled-editor-security.test.mjs",
  "tests/cases-current.test.mjs",
  "tests/ci-browser-runtime.test.mjs",
  "tests/ci-phase-admission.test.mjs",
  "tests/client-routing-availability.test.ts",
  "tests/direct-dispatch-fence.test.mjs",
  "tests/group-designation-cleanup.test.mjs",
  "tests/group-designation-evidence.test.mjs",
  "tests/group-workspace-receipts.test.mjs",
  "tests/hosted-ci.test.mjs",
  "tests/i18n-foundation.test.mjs",
  "tests/i18n-key-usage.test.mjs",
  "tests/i18n-server-surfaces.test.mjs",
  "tests/installer-held-stack.test.mjs",
  "tests/installer-held.test.mjs",
  "tests/meta-choice-current.test.mjs",
  "tests/meta-media-integrity.test.mjs",
  "tests/meta-number-release-intent.test.ts",
  "tests/meta-number-release-portal.test.ts",
  "tests/meta-number-release.test.mjs",
  "tests/meta-pinned-adapter.test.mjs",
  "tests/meta-simulation-capability.test.mjs",
  "tests/meta-simulation-faults.test.mjs",
  "tests/meta-simulation-routing.test.mjs",
  "tests/meta-simulation-signup.test.mjs",
  "tests/meta-simulation-subscription.test.mjs",
  "tests/meta-test-phone-policy.test.mjs",
  "tests/meta-test-recipient-link.test.mjs",
  "tests/meta-test-recipient-scope.test.mjs",
  "tests/native-account-observation-ui.test.ts",
  "tests/native-routing-ui.test.ts",
  "tests/owned-work-restoration.test.mjs",
  "tests/owned-work-settlement.test.mjs",
  "tests/pinned-current.test.mjs",
  "tests/release-promotion.test.mjs",
  "tests/seed-simulation-group.test.mjs",
  "tests/selected-simulation-manifest.test.mjs",
  "tests/selected-simulation-reviewed-selection.test.mjs",
  "tests/simulation-diagnostic-instrumentation.test.mjs",
  "tests/simulation-direct-capabilities.test.mjs",
  "tests/simulation-final-meta-config.test.mjs",
  "tests/simulation-group-spare.test.mjs",
  "tests/simulation-invitation-mail-diagnostic.test.mjs",
  "tests/simulation-lifecycle-census.test.mjs",
  "tests/simulation-meta-signup-stage.test.mjs",
  "tests/simulation-native-bookkeeping-policy.test.mjs",
  "tests/simulation-native-email-quality.test.mjs",
  "tests/simulation-native-quality-admission.test.mjs",
  "tests/simulation-navigation-width.test.mjs",
  "tests/simulation-pinned-contexts.test.mjs",
  "tests/simulation-q05z-adoption.test.mjs",
  "tests/simulation-q06a-adoption.test.mjs",
  "tests/simulation-routing-quality.test.mjs",
  "tests/simulation-security-admission.test.mjs",
  "tests/simulation-stage-fixtures.test.mjs",
  "tests/smtp-simulation-server.test.mjs",
  "tests/smtp-simulation-tls.test.mjs",
  "tests/tenant-shell-i18n.test.mjs",
  "tests/waha-simulation-adapter.test.mjs",
  "tests/waha-simulation-control.test.mjs",
  "tests/waha-simulation-discovery-catalogue.test.mjs",
  "tests/waha-simulation-echo.test.mjs",
  "tests/waha-simulation-expansion.test.mjs",
  "tests/waha-simulation-inbound-clock.test.mjs",
  "tests/waha-simulation-inbound-media.test.mjs",
  "tests/waha-simulation-independent-contract.test.mjs",
  "tests/waha-simulation-ingress-receipt.test.mjs",
  "tests/waha-simulation-installed-contract.test.mjs",
  "tests/waha-simulation-media.test.mjs",
  "tests/waha-simulation-mutations.test.mjs",
  "tests/waha-simulation-nickname-mentions-adapter.test.mjs",
  "tests/waha-simulation-nickname-mentions.test.mjs",
  "tests/waha-simulation-persistence.test.mjs",
  "tests/waha-simulation-qr.test.mjs",
  "tests/waha-simulation-roster.test.mjs",
  "tests/waha-simulation-scoped-arm.test.mjs",
  "tests/waha-simulation-server.test.mjs",
  "tests/waha-simulation-session-status.test.mjs",
  "tests/waha-simulation-webhook.test.mjs",
  "tests/waha-simulation-worker-health.test.mjs",
  "tests/waha-test-recipient-scope.test.mjs",
  "tests/workspace-switching.test.mjs",
];
export const unitFiles = unitInventory.map(entry => typeof entry === "string" ? entry : entry[0]);
export const unitFileTimings = Object.fromEntries(unitInventory.filter(Array.isArray));
export const { unitAllowlist } = JSON.parse(readFileSync(new URL("./hosted-ci-config.json", import.meta.url)));
const localUnitFiles = [...unitFiles, ...Object.keys(unitAllowlist).filter(file => unitAllowlist[file].runner === "test:unit")];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(`Unit Ruby prerequisite: ${unitRubyPrerequisite()} (minitest available)`);
    // Bound file workers on the shared runner; suites also spawn Ruby/Python children.
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", `--test-concurrency=${unitConcurrency()}`, ...localUnitFiles], { stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
