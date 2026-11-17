variable "environment" {
  type        = string
  description = "This root module is the production deployment contract."

  validation {
    condition     = var.environment == "production"
    error_message = "The production root module requires environment = production."
  }
}

variable "namespace" {
  type    = string
  default = "wasalx"
}

variable "portal_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.portal_image))
    error_message = "portal_image must be digest-pinned."
  }
}

variable "control_api_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.control_api_image))
    error_message = "control_api_image must be digest-pinned."
  }
}

variable "connector_worker_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.connector_worker_image))
    error_message = "connector_worker_image must be digest-pinned."
  }
}

variable "invitation_mailer_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.invitation_mailer_image))
    error_message = "invitation_mailer_image must be digest-pinned."
  }
}

variable "identity_policy_activator_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.identity_policy_activator_image))
    error_message = "identity_policy_activator_image must be digest-pinned."
  }
}

# These are names of pre-created Kubernetes Secrets, never secret material.
variable "portal_secret_name" { type = string }
variable "control_api_secret_name" { type = string }
variable "connector_worker_secret_name" { type = string }
variable "invitation_mailer_secret_name" { type = string }
variable "identity_policy_activator_secret_name" { type = string }
variable "migration_secret_name" { type = string }
variable "secret_cleanup_secret_name" { type = string }

variable "allowed_origins" {
  type = list(string)

  validation {
    condition = length(var.allowed_origins) > 0 && alltrue([
      for origin in var.allowed_origins :
      can(regex("^https://[^/?#]+$", origin)) &&
      length(regexall("(?i)(example|placeholder|changeme|replace[-_]?me|localhost|127\\.0\\.0\\.1)", origin)) == 0
    ])
    error_message = "allowed_origins must contain explicit production HTTPS origins without example or local values."
  }
}

variable "control_plane_egress" {
  description = "Per-workload least-privilege egress; do not reuse one broad list for every role."
  type = object({
    shared            = list(object({ cidr = string, ports = list(number) }))
    portal            = list(object({ cidr = string, ports = list(number) }))
    api               = list(object({ cidr = string, ports = list(number) }))
    worker            = list(object({ cidr = string, ports = list(number) }))
    invitation_mailer = list(object({ cidr = string, ports = list(number) }))
    identity_policy   = list(object({ cidr = string, ports = list(number) }))
  })

  validation {
    condition = alltrue([
      for rules in values(var.control_plane_egress) : length(rules) > 0
    ])
    error_message = "Every control-plane workload requires an explicit non-empty egress allowlist."
  }
}

variable "production_runtime" {
  description = "Public identity, media, telemetry, and service endpoints. Contains no credentials."
  type = object({
    public_webhook_base_url        = string
    control_api_url                = string
    portal_public_origin           = string
    secret_sidecar_url             = string
    waha_base_url                  = string
    waha_admin_secret_reference    = string
    otlp_endpoint                  = string
    observability_namespace        = string
    observability_runbook_base_url = string
    media_s3_endpoint              = string
    media_s3_region                = string
    media_s3_bucket                = string
    media_s3_kms_key_id            = string
    clamav_host                    = string
    clamav_port                    = number
    tenant_oidc = object({
      issuer                    = string
      audience                  = string
      jwks_uri                  = string
      client_id                 = string
      redirect_uri              = string
      invitation_redirect_uri   = string
      privileged_acr_values     = string
      privileged_mfa_amr_values = string
    })
    platform_operator_oidc = object({
      issuer               = string
      audience             = string
      jwks_uri             = string
      client_id            = string
      redirect_uri         = string
      max_auth_age_seconds = string
    })
  })

  validation {
    condition = alltrue([
      for endpoint in [
        var.production_runtime.public_webhook_base_url,
        var.production_runtime.portal_public_origin,
        var.production_runtime.secret_sidecar_url,
        var.production_runtime.otlp_endpoint,
        var.production_runtime.observability_runbook_base_url,
        var.production_runtime.media_s3_endpoint,
        var.production_runtime.tenant_oidc.issuer,
        var.production_runtime.tenant_oidc.jwks_uri,
        var.production_runtime.tenant_oidc.redirect_uri,
        var.production_runtime.tenant_oidc.invitation_redirect_uri,
        var.production_runtime.platform_operator_oidc.issuer,
        var.production_runtime.platform_operator_oidc.jwks_uri,
        var.production_runtime.platform_operator_oidc.redirect_uri,
      ] : can(regex("^https://", endpoint))
    ])
    error_message = "Every public, identity, media, telemetry, and secret-sidecar endpoint must use HTTPS."
  }

  validation {
    condition = (
      can(regex("^secret://", var.production_runtime.waha_admin_secret_reference)) &&
      can(regex("^https?://", var.production_runtime.waha_base_url)) &&
      (can(regex("^https://", var.production_runtime.control_api_url)) || can(regex("^http://[a-z0-9-]+(?::[0-9]+)?$", var.production_runtime.control_api_url)))
    )
    error_message = "WAHA must use a secret reference, and internal service URLs must be explicit HTTP(S) endpoints."
  }

  validation {
    condition = alltrue([
      for value in concat(
        [
          var.production_runtime.public_webhook_base_url,
          var.production_runtime.control_api_url,
          var.production_runtime.portal_public_origin,
          var.production_runtime.secret_sidecar_url,
          var.production_runtime.waha_base_url,
          var.production_runtime.otlp_endpoint,
          var.production_runtime.observability_runbook_base_url,
          var.production_runtime.media_s3_endpoint,
          var.production_runtime.media_s3_bucket,
          var.production_runtime.media_s3_kms_key_id,
          var.production_runtime.clamav_host,
        ],
        values(var.production_runtime.tenant_oidc),
        values(var.production_runtime.platform_operator_oidc),
      ) : length(regexall("(?i)(example|placeholder|changeme|replace[-_]?me|localhost|127\\.0\\.0\\.1)", value)) == 0
    ])
    error_message = "Production runtime inputs must not contain example, placeholder, or local values."
  }
}

variable "control_plane_backup" {
  description = "Daily control-plane logical backup using a dedicated database login and object-store identity."
  type = object({
    image                = string
    schedule             = string
    secret_name          = string
    database_name        = string
    region               = string
    storage_class_name   = string
    staging_size         = string
    s3_endpoint          = string
    s3_region            = string
    s3_bucket            = string
    s3_kms_key_reference = string
    s3_lifecycle_rule_id = string
    s3_provider          = string
    allowed_egress_cidrs = list(object({ cidr = string, ports = list(number) }))
  })

  validation {
    condition = (
      can(regex("@sha256:[0-9a-f]{64}$", var.control_plane_backup.image)) &&
      can(regex("^https://", var.control_plane_backup.s3_endpoint)) &&
      length(var.control_plane_backup.s3_kms_key_reference) > 0 &&
      length(var.control_plane_backup.allowed_egress_cidrs) > 0
    )
    error_message = "Control-plane backup requires a digest, HTTPS S3, KMS, and explicit egress."
  }
}

variable "managed_waha" {
  description = "Managed GOWS fleet configuration; credential fields are references to pre-created secrets only."
  type = object({
    image                        = string
    replicas                     = number
    capacity_per_replica         = number
    canary_ordinals              = list(number)
    canary_session_limit         = number
    session_storage_size         = string
    cluster_domain               = string
    port                         = number
    heartbeat_ttl_seconds        = number
    health_probe_timeout_seconds = number
    storage_class_name           = string
    allowed_egress_cidrs         = list(object({ cidr = string, ports = list(number) }))
    rollout_gate_secret_name     = string
    rollout_gate_egress_cidrs    = list(object({ cidr = string, ports = list(number) }))
    credential_secret_names      = list(string)
    credential_secret_references = list(string)
  })

  validation {
    condition = (
      can(regex("@sha256:[0-9a-f]{64}$", var.managed_waha.image)) &&
      var.managed_waha.replicas >= 1 &&
      var.managed_waha.port >= 1 && var.managed_waha.port <= 65535 &&
      var.managed_waha.heartbeat_ttl_seconds >= 15 && var.managed_waha.heartbeat_ttl_seconds <= 300 &&
      var.managed_waha.health_probe_timeout_seconds >= 5 && var.managed_waha.health_probe_timeout_seconds <= 30 &&
      length(var.managed_waha.credential_secret_names) == var.managed_waha.replicas &&
      length(distinct(var.managed_waha.credential_secret_names)) == var.managed_waha.replicas &&
      length(var.managed_waha.credential_secret_references) == var.managed_waha.replicas &&
      length(distinct(var.managed_waha.credential_secret_references)) == var.managed_waha.replicas &&
      alltrue([for reference in var.managed_waha.credential_secret_references : can(regex("^secret://", reference))]) &&
      length(var.managed_waha.allowed_egress_cidrs) > 0 &&
      length(var.managed_waha.rollout_gate_egress_cidrs) > 0
    )
    error_message = "Managed WAHA requires a digest, non-empty egress, and exactly one secret name/reference per replica."
  }
}

variable "workspace_provider" {
  description = "Production provider gateway configuration; all secret fields are Kubernetes Secret names."
  type = object({
    image                 = string
    service_account_name  = string
    secret_name           = string
    migration_secret_name = string
    tls_secret_name       = string
    kubernetes_audience   = string
    field_manager         = string
    request_timeout_ms    = string
    operator_deployments = object({
      identity = string
      database = string
      search   = string
      storage  = string
      secrets  = string
    })
    allowed_egress_cidrs = list(object({ cidr = string, ports = list(number) }))
  })

  validation {
    condition = (
      can(regex("@sha256:[0-9a-f]{64}$", var.workspace_provider.image)) &&
      length(var.workspace_provider.allowed_egress_cidrs) > 0 &&
      alltrue([for deployment in values(var.workspace_provider.operator_deployments) : length(deployment) > 0])
    )
    error_message = "The workspace provider requires a digest, all five operator deployments, and non-empty egress."
  }
}

variable "tenant_provisioning" {
  description = "Tenant provisioner/controller contract. Images are immutable; secret fields are names only."
  type = object({
    provisioner_image          = string
    controller_image           = string
    configurator_image         = string
    nginx_image                = string
    redis_image                = string
    memcached_image            = string
    zammad_images              = map(string)
    provisioner_secret_name    = string
    provider_secret_name       = string
    external_secret_store_name = string
    external_secret_store_kind = string
    kubernetes_api_url         = string
    kubernetes_audience        = string
    reconciler_identity        = string
    reconciler_service_account = string
    reconciler_namespace       = string
    workspace_base_domain      = string
    oidc_issuer                = string
    provider_url               = string
    control_plane_url          = string
    ingress_class_name         = string
    ingress_namespace          = string
    cluster_issuer             = string
    storage_class_name         = string
    package_version            = string
    package_sha256             = string
    backup_schedule            = string
    provisioner_egress_cidrs   = list(object({ cidr = string, ports = list(number) }))
    controller_egress_cidrs    = list(object({ cidr = string, ports = list(number) }))
  })

  validation {
    condition = alltrue([
      for image in concat([
        var.tenant_provisioning.provisioner_image,
        var.tenant_provisioning.controller_image,
        var.tenant_provisioning.configurator_image,
        var.tenant_provisioning.nginx_image,
        var.tenant_provisioning.redis_image,
        var.tenant_provisioning.memcached_image,
      ], values(var.tenant_provisioning.zammad_images)) : length(image) <= 2048 && can(regex("@sha256:[0-9a-f]{64}$", image))
      ]) && length(var.tenant_provisioning.zammad_images) > 0 && alltrue([
      for version in keys(var.tenant_provisioning.zammad_images) : length(version) <= 64 && can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$", version))
    ])
    error_message = "Every provisioning, dependency, and supported Zammad image must be digest-pinned."
  }

  validation {
    condition = (
      can(regex("^https://", var.tenant_provisioning.kubernetes_api_url)) &&
      can(regex("^https://", var.tenant_provisioning.oidc_issuer)) &&
      can(regex("^https://", var.tenant_provisioning.provider_url)) &&
      can(regex("^https://", var.tenant_provisioning.control_plane_url)) &&
      length(var.tenant_provisioning.package_version) <= 64 &&
      can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$", var.tenant_provisioning.package_version)) &&
      can(regex("^[0-9a-f]{64}$", var.tenant_provisioning.package_sha256)) &&
      contains(["ClusterSecretStore", "SecretStore"], var.tenant_provisioning.external_secret_store_kind) &&
      length(var.tenant_provisioning.provisioner_egress_cidrs) > 0 &&
      length(var.tenant_provisioning.controller_egress_cidrs) > 0
    )
    error_message = "Provisioning requires HTTPS service identities, an immutable package, a supported secret store, and non-empty egress."
  }

  validation {
    condition = alltrue([
      for value in [
        var.tenant_provisioning.workspace_base_domain,
        var.tenant_provisioning.kubernetes_api_url,
        var.tenant_provisioning.kubernetes_audience,
        var.tenant_provisioning.reconciler_identity,
        var.tenant_provisioning.oidc_issuer,
        var.tenant_provisioning.provider_url,
        var.tenant_provisioning.control_plane_url,
      ] : length(regexall("(?i)(example|placeholder|changeme|replace[-_]?me|localhost|127\\.0\\.0\\.1)", value)) == 0
    ])
    error_message = "Provisioning domains and endpoints must be real production values."
  }
}

variable "application_namespace" {
  type = string
  description = "Operator-supplied Kubernetes namespace; never a committed deployment identity."
  validation {
    condition = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.application_namespace))
    error_message = "Supply a valid Kubernetes namespace."
  }
}

variable "secret_store_namespace" {
  type = string
  description = "Operator-supplied Kubernetes namespace; never a committed deployment identity."
  validation {
    condition = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.secret_store_namespace))
    error_message = "Supply a valid Kubernetes namespace."
  }
}
