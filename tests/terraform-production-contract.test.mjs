import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, repository), "utf8");

test("OpenTofu passes the complete production runtime into Helm", async () => {
  const main = await read("infra/terraform/main.tf");
  const compact = main.replace(/\s+/gu, " ");

  for (const assignment of [
    "environment = var.environment",
    "publicWebhookBaseUrl = var.production_runtime.public_webhook_base_url",
    "secretSidecarUrl = var.production_runtime.secret_sidecar_url",
    "wahaAdminSecretReference = var.production_runtime.waha_admin_secret_reference",
    "portalPublicOrigin = var.production_runtime.portal_public_origin",
    "serverSideEncryption = \"aws:kms\"",
    "kmsKeyId = var.production_runtime.media_s3_kms_key_id",
    "controlPlaneBackup = {",
    "image = var.control_plane_backup.image",
    "managedWaha = {",
    "heartbeatTtlSeconds = var.managed_waha.heartbeat_ttl_seconds",
    "workspaceProvider = {",
    "kubernetesAudience = var.workspace_provider.kubernetes_audience",
    "provisioner = {",
    "reconcilerIdentity = var.tenant_provisioning.reconciler_identity",
    "configuratorImage = var.tenant_provisioning.configurator_image",
    "zammadImages = var.tenant_provisioning.zammad_images",
    "admissionPolicy = { enabled = true }",
  ]) {
    assert.ok(compact.includes(assignment), `missing Helm handoff: ${assignment}`);
  }

  assert.match(main, /managedWaha\s*=\s*\{[\s\S]*?enabled\s*=\s*true/u);
  assert.match(main, /workspaceProvider\s*=\s*\{[\s\S]*?enabled\s*=\s*true/u);
  assert.match(main, /provisioner\s*=\s*\{[\s\S]*?enabled\s*=\s*true/u);
  assert.match(main, /resource "kubernetes_network_policy_v1" "bootstrap_default_deny"/u);
  assert.match(main, /resource "kubernetes_network_policy_v1" "control_migration_egress"/u);
  assert.match(main, /resource "kubernetes_network_policy_v1" "workspace_migration_egress"/u);
  assert.match(
    main,
    /depends_on\s*=\s*\[[\s\S]*?bootstrap_default_deny[\s\S]*?control_migration_egress[\s\S]*?workspace_migration_egress/u,
  );
  assert.doesNotMatch(main, /(?:example|placeholder|changeme|replace[-_]?me|localhost|127\.0\.0\.1|:dev)/iu);
});

test("native OpenTofu plan exercises the production root without credentials", async () => {
  const planTest = await read("infra/terraform/tests/production_plan.tftest.hcl");
  const validation = await read("scripts/validate-infra.sh");

  assert.match(planTest, /mock_provider "kubernetes" \{\}/u);
  assert.match(planTest, /mock_provider "helm" \{\}/u);
  assert.match(planTest, /run "production_plan" \{[\s\S]*?command = plan/u);
  assert.match(planTest, /plan_options \{[\s\S]*?refresh = false/u);
  assert.match(planTest, /kubernetes_namespace\.wasalx\.metadata\[0\]\.name == "wasalx-production"/u);
  assert.match(planTest, /kubernetes_network_policy_v1\.bootstrap_default_deny/u);
  assert.match(planTest, /kubernetes_network_policy_v1\.control_migration_egress/u);
  assert.match(planTest, /kubernetes_network_policy_v1\.workspace_migration_egress/u);
  assert.match(planTest, /helm_release\.control_plane\.atomic/u);
  assert.match(planTest, /helm_release\.control_plane\.cleanup_on_fail/u);
  assert.match(planTest, /yamldecode\(helm_release\.control_plane\.values\[0\]\)\.managedWaha\.gows\.enabled/u);
  assert.match(planTest, /provisioner\.controller\.admissionPolicy\.enabled/u);
  assert.doesNotMatch(
    planTest,
    /(?:password|client_secret|api_key|access_key|private_key|database_url|session_secret)\s*=/iu,
  );

  assert.match(validation, /-chdir=infra\/terraform init -backend=false -input=false -lockfile=readonly/u);
  assert.match(validation, /-chdir=infra\/terraform test -no-color\n/u);
  assert.match(validation, /if \[\[ "\$\{1:-\}" == --terraform-test-only \]\]; then\n\s+export TF_DATA_DIR=.*\n\s+prepare_tofu_providers "\$HOST_PROVIDER_TARGET"\n\s+prepare_native_tofu\n\s+init_terraform\n\s+run_terraform_tests\n/u);
});

test("production inputs fail closed without carrying secret material", async () => {
  const variables = await read("infra/terraform/variables.tf");
  const main = await read("infra/terraform/main.tf");

  assert.match(variables, /condition\s*=\s*var\.environment == "production"/u);
  assert.match(variables, /allowed_origins[\s\S]*?length\(var\.allowed_origins\) > 0/u);
  assert.match(variables, /Every control-plane workload requires an explicit non-empty egress allowlist/u);
  assert.match(variables, /@sha256:\[0-9a-f\]\{64\}\$/u);
  assert.match(variables, /Production runtime inputs must not contain example, placeholder, or local values/u);
  assert.match(variables, /exactly one secret name\/reference per replica/u);
  assert.match(variables, /Every provisioning, dependency, and supported Zammad image must be digest-pinned/u);

  const declaredVariables = [
    ...variables.matchAll(/variable\s+"([^"]+)"/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    declaredVariables.filter((name) =>
      /(?:password|client_secret|api_key|access_key|private_key|database_url|session_secret)/u.test(name),
    ),
    [],
    "Terraform accepts references and Secret names, never credential payloads",
  );

  for (const role of [
    "shared",
    "portal",
    "api",
    "worker",
    "invitation_mailer",
    "identity_policy",
  ]) {
    assert.ok(main.includes(`var.control_plane_egress.${role}`));
  }
  assert.match(main, /distinct\(concat\(\[[\s\S]*?credential_secret_names\)\)\) == 14 \+ var\.managed_waha\.replicas/u);
  assert.match(main, /tenant_oidc\.client_id != var\.production_runtime\.platform_operator_oidc\.client_id/u);
});

test("production OpenTofu state uses an explicit, locked S3 backend", async () => {
  const versions = await read("infra/terraform/versions.tf");

  const backend = versions.match(/backend\s+"s3"\s*\{([\s\S]*?)\n\s*\}/u)?.[1];

  assert.ok(backend, "the production root must declare the S3 backend");
  assert.match(versions, /required_version\s*=\s*">= 1\.10\.0"/u);
  assert.match(backend, /use_lockfile\s*=\s*true/u);
  assert.match(backend, /encrypt\s*=\s*true/u);
  assert.doesNotMatch(backend, /\b(?:bucket|region)\s*=/u);
  assert.doesNotMatch(
    backend,
    /\b(?:access_key|secret_key|token|profile|role_arn)\s*=/u,
  );

  
  
  
  
});
