resource "kubernetes_namespace" "wasalx" {
  metadata {
    name = var.application_namespace != null ? var.application_namespace : "${var.namespace}-${var.environment}"
    labels = {
      "app.kubernetes.io/part-of" = "wasalx"
      environment                 = var.environment
    }
  }
}

resource "kubernetes_network_policy_v1" "bootstrap_default_deny" {
  metadata {
    name      = "wasalx-bootstrap-default-deny"
    namespace = kubernetes_namespace.wasalx.metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }
}

resource "kubernetes_network_policy_v1" "control_migration_egress" {
  metadata {
    name      = "wasalx-bootstrap-control-migration-egress"
    namespace = kubernetes_namespace.wasalx.metadata[0].name
  }

  spec {
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name" = "wasalx-migration"
        "wasalx.io/plane"        = "control"
      }
    }
    policy_types = ["Egress"]

    dynamic "egress" {
      for_each = var.control_plane_egress.api
      content {
        to {
          ip_block { cidr = egress.value.cidr }
        }
        dynamic "ports" {
          for_each = egress.value.ports
          content {
            port     = tostring(ports.value)
            protocol = "TCP"
          }
        }
      }
    }
  }
}

resource "kubernetes_network_policy_v1" "workspace_migration_egress" {
  metadata {
    name      = "wasalx-bootstrap-workspace-migration-egress"
    namespace = kubernetes_namespace.wasalx.metadata[0].name
  }

  spec {
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name" = "wasalx-workspace-provider-migration"
      }
    }
    policy_types = ["Egress"]

    dynamic "egress" {
      for_each = var.workspace_provider.allowed_egress_cidrs
      content {
        to {
          ip_block { cidr = egress.value.cidr }
        }
        dynamic "ports" {
          for_each = egress.value.ports
          content {
            port     = tostring(ports.value)
            protocol = "TCP"
          }
        }
      }
    }
  }
}

resource "helm_release" "control_plane" {
  name      = "wasalx-control-plane"
  namespace = kubernetes_namespace.wasalx.metadata[0].name
  chart     = "${path.module}/../helm/wasalx"
  skip_crds = true
  # Migrations may already have committed when readiness fails. Recovery must
  # assess database compatibility before replacing images or removing resources.
  atomic          = false
  cleanup_on_fail = false
  wait            = true
  wait_for_jobs   = true
  timeout         = 900


  depends_on = [
    kubernetes_role_binding_v1.secret_adapter,
    kubernetes_network_policy_v1.bootstrap_default_deny,
    kubernetes_network_policy_v1.control_migration_egress,
    kubernetes_network_policy_v1.workspace_migration_egress,
  ]

  values = [yamlencode({
    environment          = var.environment
    allowedOrigins       = var.allowed_origins
    publicWebhookBaseUrl = var.production_runtime.public_webhook_base_url
    secretSidecarUrl     = var.production_runtime.secret_sidecar_url
    productionSecretSidecar = {
      enabled               = var.production_secret_sidecar != null
      image                 = try(var.production_secret_sidecar.image, "")
      credentialsSecretName = try(var.production_secret_sidecar.credentials_secret_name, "")
      tlsSecretName         = try(var.production_secret_sidecar.tls_secret_name, "")
      caConfigMapName       = try(var.production_secret_sidecar.ca_config_map_name, "")
      apiServerCidrs        = try(var.production_secret_sidecar.api_server_cidrs, [])
      storeNamespace        = try(kubernetes_namespace.secret_store[0].metadata[0].name, "")
    }
    wahaBaseUrl              = var.production_runtime.waha_base_url
    wahaAdminSecretReference = var.production_runtime.waha_admin_secret_reference

    portalDataBackend  = "control-plane"
    controlApiUrl      = var.production_runtime.control_api_url
    portalCookieSecure = "true"
    portalPublicOrigin = var.production_runtime.portal_public_origin

    oidc = {
      issuer                 = var.production_runtime.tenant_oidc.issuer
      audience               = var.production_runtime.tenant_oidc.audience
      jwksUri                = var.production_runtime.tenant_oidc.jwks_uri
      clientId               = var.production_runtime.tenant_oidc.client_id
      redirectUri            = var.production_runtime.tenant_oidc.redirect_uri
      invitationRedirectUri  = var.production_runtime.tenant_oidc.invitation_redirect_uri
      privilegedAcrValues    = var.production_runtime.tenant_oidc.privileged_acr_values
      privilegedMfaAmrValues = var.production_runtime.tenant_oidc.privileged_mfa_amr_values
    }
    platformOperatorOidc = {
      issuer            = var.production_runtime.platform_operator_oidc.issuer
      audience          = var.production_runtime.platform_operator_oidc.audience
      jwksUri           = var.production_runtime.platform_operator_oidc.jwks_uri
      clientId          = var.production_runtime.platform_operator_oidc.client_id
      redirectUri       = var.production_runtime.platform_operator_oidc.redirect_uri
      maxAuthAgeSeconds = var.production_runtime.platform_operator_oidc.max_auth_age_seconds
    }

    observability = {
      enabled                = true
      otlpEndpoint           = var.production_runtime.otlp_endpoint
      metricExportIntervalMs = "15000"
      tracesSampler          = "parentbased_traceidratio"
      tracesSamplerArg       = "0.25"
      collector = {
        namespace = var.production_runtime.observability_namespace
        podLabels = { "app.kubernetes.io/name" = "opentelemetry-collector" }
        port      = 4318
      }
      prometheusRule = {
        enabled        = true
        namespace      = var.production_runtime.observability_namespace
        labels         = { release = "kube-prometheus-stack" }
        runbookBaseUrl = var.production_runtime.observability_runbook_base_url
      }
    }
    media = {
      s3 = {
        endpoint             = var.production_runtime.media_s3_endpoint
        region               = var.production_runtime.media_s3_region
        bucket               = var.production_runtime.media_s3_bucket
        serverSideEncryption = "aws:kms"
        kmsKeyId             = var.production_runtime.media_s3_kms_key_id
      }
      clamav = {
        host = var.production_runtime.clamav_host
        port = var.production_runtime.clamav_port
      }
    }
    controlPlaneBackup = {
      enabled            = true
      image              = var.control_plane_backup.image
      schedule           = var.control_plane_backup.schedule
      secretName         = var.control_plane_backup.secret_name
      databaseName       = var.control_plane_backup.database_name
      region             = var.control_plane_backup.region
      storageClassName   = var.control_plane_backup.storage_class_name
      stagingSize        = var.control_plane_backup.staging_size
      allowedEgressCidrs = var.control_plane_backup.allowed_egress_cidrs
      s3 = {
        endpoint        = var.control_plane_backup.s3_endpoint
        region          = var.control_plane_backup.s3_region
        bucket          = var.control_plane_backup.s3_bucket
        kmsKeyReference = var.control_plane_backup.s3_kms_key_reference
        lifecycleRuleId = var.control_plane_backup.s3_lifecycle_rule_id
        provider        = var.control_plane_backup.s3_provider
      }
    }

    managedWaha = {
      enabled                   = true
      clusterDomain             = var.managed_waha.cluster_domain
      port                      = var.managed_waha.port
      heartbeatTtlSeconds       = var.managed_waha.heartbeat_ttl_seconds
      healthProbeTimeoutSeconds = var.managed_waha.health_probe_timeout_seconds
      storageClassName          = var.managed_waha.storage_class_name
      allowedEgressCidrs        = var.managed_waha.allowed_egress_cidrs
      rolloutGate = {
        secretName         = var.managed_waha.rollout_gate_secret_name
        allowedEgressCidrs = var.managed_waha.rollout_gate_egress_cidrs
      }
      gows = {
        enabled                      = true
        image                        = var.managed_waha.image
        replicas                     = var.managed_waha.replicas
        capacityPerReplica           = var.managed_waha.capacity_per_replica
        canaryOrdinals               = var.managed_waha.canary_ordinals
        canarySessionLimitPerReplica = var.managed_waha.canary_session_limit
        sessionStorageSize           = var.managed_waha.session_storage_size
        credentialSecretNames        = var.managed_waha.credential_secret_names
        secretReferences             = var.managed_waha.credential_secret_references
      }
      noweb = { enabled = false }
    }

    workspaceProvider = {
      enabled             = true
      image               = var.workspace_provider.image
      serviceAccountName  = var.workspace_provider.service_account_name
      secretName          = var.workspace_provider.secret_name
      migrationSecretName = var.workspace_provider.migration_secret_name
      tlsSecretName       = var.workspace_provider.tls_secret_name
      kubernetesAudience  = var.workspace_provider.kubernetes_audience
      fieldManager        = var.workspace_provider.field_manager
      requestTimeoutMs    = var.workspace_provider.request_timeout_ms
      operatorDeployments = var.workspace_provider.operator_deployments
      allowedEgressCidrs  = var.workspace_provider.allowed_egress_cidrs
    }

    ingressNamespace = var.tenant_provisioning.ingress_namespace
    provisioner = {
      enabled                           = true
      image                             = var.tenant_provisioning.provisioner_image
      secretName                        = var.tenant_provisioning.provisioner_secret_name
      kubernetesApiUrl                  = var.tenant_provisioning.kubernetes_api_url
      kubernetesAudience                = var.tenant_provisioning.kubernetes_audience
      reconcilerIdentity                = var.tenant_provisioning.reconciler_identity
      reconcilerServiceAccount          = var.tenant_provisioning.reconciler_service_account
      reconcilerServiceAccountNamespace = var.tenant_provisioning.reconciler_namespace
      workspaceBaseDomain               = var.tenant_provisioning.workspace_base_domain
      oidcIssuer                        = var.tenant_provisioning.oidc_issuer
      packageVersion                    = var.tenant_provisioning.package_version
      packageSha256                     = var.tenant_provisioning.package_sha256
      allowedEgressCidrs                = var.tenant_provisioning.provisioner_egress_cidrs
      controller = {
        image                   = var.tenant_provisioning.controller_image
        providerUrl             = var.tenant_provisioning.provider_url
        controlPlaneUrl         = var.tenant_provisioning.control_plane_url
        providerSecretName      = var.tenant_provisioning.provider_secret_name
        externalSecretStoreName = var.tenant_provisioning.external_secret_store_name
        externalSecretStoreKind = var.tenant_provisioning.external_secret_store_kind
        ingressClassName        = var.tenant_provisioning.ingress_class_name
        ingressNamespace        = var.tenant_provisioning.ingress_namespace
        clusterIssuer           = var.tenant_provisioning.cluster_issuer
        storageClassName        = var.tenant_provisioning.storage_class_name
        configuratorImage       = var.tenant_provisioning.configurator_image
        nginxImage              = var.tenant_provisioning.nginx_image
        redisImage              = var.tenant_provisioning.redis_image
        memcachedImage          = var.tenant_provisioning.memcached_image
        zammadImages            = var.tenant_provisioning.zammad_images
        backupSchedule          = var.tenant_provisioning.backup_schedule
        allowedEgressCidrs      = var.tenant_provisioning.controller_egress_cidrs
        admissionPolicy         = { enabled = true }
      }
    }

    portal                  = { image = var.portal_image, replicas = 2, secretName = var.portal_secret_name }
    api                     = { image = var.control_api_image, replicas = 2, secretName = var.control_api_secret_name, cleanupSecretName = var.secret_cleanup_secret_name }
    worker                  = { image = var.connector_worker_image, replicas = 2, secretName = var.connector_worker_secret_name }
    invitationMailer        = { image = var.invitation_mailer_image, replicas = 2, secretName = var.invitation_mailer_secret_name }
    identityPolicyActivator = { image = var.identity_policy_activator_image, replicas = 2, secretName = var.identity_policy_activator_secret_name }
    migration               = { image = var.control_api_image, secretName = var.migration_secret_name }

    allowedEgressCidrs                 = var.control_plane_egress.shared
    portalAllowedEgressCidrs           = var.control_plane_egress.portal
    apiAllowedEgressCidrs              = var.control_plane_egress.api
    workerAllowedEgressCidrs           = var.control_plane_egress.worker
    invitationMailerAllowedEgressCidrs = var.control_plane_egress.invitation_mailer
    identityPolicyAllowedEgressCidrs   = var.control_plane_egress.identity_policy
    podSecurityContext                 = { runAsNonRoot = true, runAsUser = 1000, runAsGroup = 1000, fsGroup = 1000, fsGroupChangePolicy = "OnRootMismatch", seccompProfile = { type = "RuntimeDefault" } }
  })]

  lifecycle {
    precondition {
      condition     = var.production_secret_sidecar == null || var.production_runtime.secret_sidecar_url == "https://secrets-agent.${kubernetes_namespace.wasalx.metadata[0].name}.svc.cluster.local:8443"
      error_message = "The managed secret adapter URL must match the production application namespace."
    }
    precondition {
      condition     = contains(var.allowed_origins, var.production_runtime.portal_public_origin)
      error_message = "allowed_origins must include portal_public_origin exactly."
    }
    precondition {
      condition = length(distinct(concat([
        var.portal_secret_name,
        var.control_api_secret_name,
        var.connector_worker_secret_name,
        var.invitation_mailer_secret_name,
        var.identity_policy_activator_secret_name,
        var.migration_secret_name,
        var.secret_cleanup_secret_name,
        var.managed_waha.rollout_gate_secret_name,
        var.workspace_provider.secret_name,
        var.workspace_provider.migration_secret_name,
        var.workspace_provider.tls_secret_name,
        var.tenant_provisioning.provisioner_secret_name,
        var.tenant_provisioning.provider_secret_name,
        var.control_plane_backup.secret_name,
      ], var.managed_waha.credential_secret_names))) == 14 + var.managed_waha.replicas
      error_message = "Each workload, WAHA worker, provider, backup, migration, and cleanup role requires a distinct Kubernetes Secret."
    }
    precondition {
      condition = (
        var.production_runtime.tenant_oidc.client_id != var.production_runtime.platform_operator_oidc.client_id &&
        var.production_runtime.tenant_oidc.redirect_uri != var.production_runtime.platform_operator_oidc.redirect_uri
      )
      error_message = "Tenant and platform-operator OIDC clients and redirects must be isolated."
    }
    precondition {
      condition     = !contains(var.managed_waha.credential_secret_references, var.production_runtime.waha_admin_secret_reference)
      error_message = "The WAHA admin and worker API identities require distinct secret references."
    }
  }
}

// WasalX no longer lets Terraform create an unfenced, single-container tenant
// workspace. Existing state is detached without deleting live workloads; the
// operator must follow the documented data migration and cutover runbook.
removed {
  from = module.tenant

  lifecycle {
    destroy = false
  }
}
