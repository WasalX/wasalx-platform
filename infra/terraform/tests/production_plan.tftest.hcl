variables {
  application_namespace = "wasalx"
  secret_store_namespace = "wasalx-secrets"
}

mock_provider "kubernetes" {}
mock_provider "helm" {}

variables {
  environment = "production"
  namespace   = "wasalx"

  portal_image                    = "example.test/portal@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  control_api_image               = "example.test/control-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  connector_worker_image          = "example.test/connector-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  invitation_mailer_image         = "example.test/invitation-mailer@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  identity_policy_activator_image = "example.test/identity-policy-activator@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

  portal_secret_name                    = "portal-runtime"
  control_api_secret_name               = "control-api-runtime"
  connector_worker_secret_name          = "connector-worker-runtime"
  invitation_mailer_secret_name         = "invitation-mailer-runtime"
  identity_policy_activator_secret_name = "identity-policy-runtime"
  migration_secret_name                 = "control-migration-runtime"
  secret_cleanup_secret_name            = "secret-cleanup-runtime"

  allowed_origins = ["https://example.test"]

  control_plane_egress = {
    shared            = [{ cidr = "192.0.2.1/8", ports = [443] }]
    portal            = [{ cidr = "192.0.2.1/8", ports = [443, 6379] }]
    api               = [{ cidr = "192.0.2.1/8", ports = [443, 5432, 6379] }]
    worker            = [{ cidr = "192.0.2.1/8", ports = [443, 3310, 5432, 6379] }]
    invitation_mailer = [{ cidr = "192.0.2.1/8", ports = [443, 5432] }]
    identity_policy   = [{ cidr = "192.0.2.1/8", ports = [443, 5432] }]
  }

  production_runtime = {
    public_webhook_base_url        = "https://example.test"
    control_api_url                = "https://example.test"
    portal_public_origin           = "https://example.test"
    secret_sidecar_url             = "https://secrets-agent.wasalx-production.svc.cluster.local:8443"
    waha_base_url                  = "https://example.test"
    waha_admin_secret_reference    = "secret://platform/waha/admin"
    otlp_endpoint                  = "https://example.test:4318"
    observability_namespace        = "observability"
    observability_runbook_base_url = "https://example.test"
    media_s3_endpoint              = "https://example.test"
    media_s3_region                = "me-central-1"
    media_s3_bucket                = "wasalx-prod-media"
    media_s3_kms_key_id            = "arn:aws:kms:me-central-1:111122223333:key/wasalx-prod-media"
    clamav_host                    = "clamav.security.svc.cluster.local"
    clamav_port                    = 3310
    tenant_oidc = {
      issuer                    = "https://example.test/realms/tenant"
      audience                  = "wasalx-control-api"
      jwks_uri                  = "https://example.test/realms/tenant/certs"
      client_id                 = "wasalx-tenant-portal"
      redirect_uri              = "https://example.test/auth/callback"
      invitation_redirect_uri   = "https://example.test/invitations/callback"
      privileged_acr_values     = "urn:wasalx:aal2"
      privileged_mfa_amr_values = "mfa,otp"
    }
    platform_operator_oidc = {
      issuer               = "https://example.test/realms/platform"
      audience             = "wasalx-platform-api"
      jwks_uri             = "https://example.test/realms/platform/certs"
      client_id            = "wasalx-platform-portal"
      redirect_uri         = "https://example.test/platform/auth/callback"
      max_auth_age_seconds = "300"
    }
  }

  control_plane_backup = {
    image                = "example.test/workspace-configurator@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    schedule             = "17 1 * * *"
    secret_name          = "control-backup-runtime"
    database_name        = "wasalx_control"
    region               = "me-central-1"
    storage_class_name   = "encrypted-block"
    staging_size         = "20Gi"
    s3_endpoint          = "https://example.test"
    s3_region            = "me-central-1"
    s3_bucket            = "wasalx-prod-control-backups"
    s3_kms_key_reference = "arn:aws:kms:me-central-1:111122223333:key/wasalx-prod-control-backup"
    s3_lifecycle_rule_id = "wasalx-prod-control-backup-retention"
    s3_provider          = "aws"
    allowed_egress_cidrs = [{ cidr = "192.0.2.1/8", ports = [443, 5432] }]
  }

  managed_waha = {
    image                        = "example.test/waha-gows@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    replicas                     = 1
    capacity_per_replica         = 250
    canary_ordinals              = [0]
    canary_session_limit         = 5
    session_storage_size         = "20Gi"
    cluster_domain               = "cluster.local"
    port                         = 3000
    heartbeat_ttl_seconds        = 60
    health_probe_timeout_seconds = 10
    storage_class_name           = "encrypted-block"
    allowed_egress_cidrs         = [{ cidr = "192.0.2.1/10", ports = [443] }]
    rollout_gate_secret_name     = "waha-rollout-gate-runtime"
    rollout_gate_egress_cidrs    = [{ cidr = "192.0.2.1/8", ports = [5432] }]
    credential_secret_names      = ["waha-gows-0-runtime"]
    credential_secret_references = ["secret://platform/waha/gows-0"]
  }

  workspace_provider = {
    image                 = "example.test/workspace-provider@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    service_account_name  = "workspace-provider"
    secret_name           = "workspace-provider-runtime"
    migration_secret_name = "workspace-provider-migration-runtime"
    tls_secret_name       = "workspace-provider-tls"
    kubernetes_audience   = "wasalx-workspace-provider"
    field_manager         = "wasalx-workspace-provider"
    request_timeout_ms    = "30000"
    operator_deployments = {
      identity = "identity-operator"
      database = "database-operator"
      search   = "search-operator"
      storage  = "storage-operator"
      secrets  = "secrets-operator"
    }
    allowed_egress_cidrs = [{ cidr = "192.0.2.1/8", ports = [443, 5432] }]
  }

  tenant_provisioning = {
    provisioner_image          = "example.test/tenant-provisioner@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    controller_image           = "example.test/tenant-workspace-controller@sha256:3333333333333333333333333333333333333333333333333333333333333333"
    configurator_image         = "example.test/workspace-configurator@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    nginx_image                = "example.test/nginx@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    redis_image                = "example.test/redis@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    memcached_image            = "example.test/memcached@sha256:6666666666666666666666666666666666666666666666666666666666666666"
    zammad_images              = { "7.1.3" = "example.test/zammad@sha256:7777777777777777777777777777777777777777777777777777777777777777" }
    provisioner_secret_name    = "tenant-provisioner-runtime"
    provider_secret_name       = "tenant-provider-runtime"
    external_secret_store_name = "example-runtime"
    external_secret_store_kind = "ClusterSecretStore"
    kubernetes_api_url         = "https://kubernetes.default.svc.cluster.local"
    kubernetes_audience        = "wasalx-tenant-provisioner"
    reconciler_identity        = "system:serviceaccount:wasalx-system:tenant-workspace-controller"
    reconciler_service_account = "tenant-workspace-controller"
    reconciler_namespace       = "wasalx-system"
    workspace_base_domain      = "example.test"
    oidc_issuer                = "https://example.test/realms/tenant"
    provider_url               = "https://workspace-provider.wasalx.svc.cluster.local:8092"
    control_plane_url          = "https://wasalx-api.wasalx.svc.cluster.local:3001"
    ingress_class_name         = "nginx"
    ingress_namespace          = "ingress-nginx"
    cluster_issuer             = "wasalx-production"
    storage_class_name         = "encrypted-block"
    package_version            = "1.0.0"
    package_sha256             = "8888888888888888888888888888888888888888888888888888888888888888"
    backup_schedule            = "23 2 * * *"
    provisioner_egress_cidrs   = [{ cidr = "192.0.2.1/8", ports = [443, 5432] }]
    controller_egress_cidrs    = [{ cidr = "192.0.2.1/8", ports = [443, 5432, 6379, 9200] }]
  }
}

run "production_plan" {
  command = plan

  plan_options {
    refresh = false
  }

  assert {
    condition     = kubernetes_namespace.wasalx.metadata[0].name == "wasalx-production"
    error_message = "The production namespace must be explicit and environment-scoped."
  }

  assert {
    condition = (
      kubernetes_network_policy_v1.bootstrap_default_deny.metadata[0].namespace == "wasalx-production" &&
      toset(kubernetes_network_policy_v1.bootstrap_default_deny.spec[0].policy_types) == toset(["Ingress", "Egress"]) &&
      kubernetes_network_policy_v1.control_migration_egress.metadata[0].namespace == "wasalx-production" &&
      length(kubernetes_network_policy_v1.control_migration_egress.spec[0].egress) > 0 &&
      kubernetes_network_policy_v1.workspace_migration_egress.metadata[0].namespace == "wasalx-production" &&
      length(kubernetes_network_policy_v1.workspace_migration_egress.spec[0].egress) > 0
    )
    error_message = "Deny-by-default and migration egress policies must exist before Helm receives database credentials."
  }

  assert {
    condition = (
      helm_release.control_plane.name == "wasalx-control-plane" &&
      helm_release.control_plane.namespace == "wasalx-production" &&
      helm_release.control_plane.skip_crds &&
      !helm_release.control_plane.atomic &&
      !helm_release.control_plane.cleanup_on_fail &&
      helm_release.control_plane.wait &&
      helm_release.control_plane.wait_for_jobs
    )
    error_message = "Production must wait for readiness/jobs without automatic rollback or failed-resource cleanup."
  }

  assert {
    condition = (
      yamldecode(helm_release.control_plane.values[0]).environment == "production" &&
      yamldecode(helm_release.control_plane.values[0]).portalCookieSecure == "true" &&
      yamldecode(helm_release.control_plane.values[0]).media.s3.serverSideEncryption == "aws:kms" &&
      yamldecode(helm_release.control_plane.values[0]).controlPlaneBackup.enabled &&
      yamldecode(helm_release.control_plane.values[0]).managedWaha.enabled &&
      yamldecode(helm_release.control_plane.values[0]).managedWaha.gows.enabled &&
      !yamldecode(helm_release.control_plane.values[0]).managedWaha.noweb.enabled &&
      yamldecode(helm_release.control_plane.values[0]).workspaceProvider.enabled &&
      yamldecode(helm_release.control_plane.values[0]).provisioner.enabled &&
      yamldecode(helm_release.control_plane.values[0]).provisioner.controller.admissionPolicy.enabled
    )
    error_message = "The real production Helm handoff must keep every fail-closed runtime enabled."
  }

  assert {
    condition = (
      endswith(yamldecode(helm_release.control_plane.values[0]).portal.image, "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") &&
      endswith(yamldecode(helm_release.control_plane.values[0]).worker.image, "@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc") &&
      length(yamldecode(helm_release.control_plane.values[0]).workerAllowedEgressCidrs) > 0 &&
      length(yamldecode(helm_release.control_plane.values[0]).managedWaha.allowedEgressCidrs) > 0 &&
      length(yamldecode(helm_release.control_plane.values[0]).provisioner.controller.allowedEgressCidrs) > 0
    )
    error_message = "Production images must remain immutable and required egress lists non-empty."
  }
}

run "production_secret_adapter" {
  command = plan
  plan_options { refresh = false }
  variables {
    production_secret_sidecar = {
      image                   = "example.test/secrets@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      credentials_secret_name = "secret-adapter-credentials"
      tls_secret_name         = "secret-adapter-tls"
      ca_config_map_name      = "secret-adapter-ca"
      api_server_cidrs        = ["192.0.2.1/32"]
    }
  }
  assert {
    condition = (
      kubernetes_namespace.secret_store[0].metadata[0].name == "wasalx-production-secrets" &&
      kubernetes_role_v1.secret_adapter[0].metadata[0].namespace == "wasalx-production-secrets" &&
      toset(kubernetes_role_v1.secret_adapter[0].rule[0].verbs) == toset(["get", "create", "update", "delete"]) &&
      toset(kubernetes_role_v1.secret_adapter[0].rule[0].resources) == toset(["secrets"]) &&
      kubernetes_role_binding_v1.secret_adapter[0].subject[0].namespace == "wasalx-production" &&
      !kubernetes_service_account_v1.secret_adapter[0].automount_service_account_token &&
      yamldecode(helm_release.control_plane.values[0]).productionSecretSidecar.storeNamespace == "wasalx-production-secrets" &&
      yamldecode(helm_release.control_plane.values[0]).productionSecretSidecar.enabled
    )
    error_message = "The adapter must receive scoped secret-store access and an environment-specific Helm handoff."
  }
}

run "reject_secret_adapter_namespace_mismatch" {
  command = plan
  plan_options { refresh = false }
  variables {
    namespace = "another"
    production_secret_sidecar = {
      image                   = "example.test/secrets@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      credentials_secret_name = "secret-adapter-credentials"
      tls_secret_name         = "secret-adapter-tls"
      ca_config_map_name      = "secret-adapter-ca"
      api_server_cidrs        = ["192.0.2.1/32"]
    }
  }
  expect_failures = [helm_release.control_plane]
}
