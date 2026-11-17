variable "production_secret_sidecar" {
  description = "Optional Kubernetes-backed secret adapter; credentials and CA resources must already exist in the application namespace."
  type = object({
    image                   = string
    credentials_secret_name = string
    tls_secret_name         = string
    ca_config_map_name      = string
    api_server_cidrs        = list(string)
  })
  default = null
  validation {
    condition = var.production_secret_sidecar == null ? true : (
      can(regex("@sha256:[0-9a-f]{64}$", var.production_secret_sidecar.image)) &&
      alltrue([for name in [var.production_secret_sidecar.credentials_secret_name, var.production_secret_sidecar.tls_secret_name, var.production_secret_sidecar.ca_config_map_name] : can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", name))]) &&
      length(var.production_secret_sidecar.api_server_cidrs) > 0 &&
      alltrue([for cidr in var.production_secret_sidecar.api_server_cidrs : can(cidrhost(cidr, 0)) && can(regex(strcontains(cidr, ":") ? "/128$" : "/32$", cidr))])
    )
    error_message = "The secret adapter needs a digest image, named credentials/TLS/CA resources and individual valid API host addresses."
  }
}

resource "kubernetes_namespace" "secret_store" {
  count = var.production_secret_sidecar == null ? 0 : 1
  metadata {
    name   = var.secret_store_namespace
    labels = { "pod-security.kubernetes.io/enforce" = "restricted" }
  }
  # Durable application credentials must survive application removal/replacement.
  lifecycle { prevent_destroy = true }
}

resource "kubernetes_service_account_v1" "secret_adapter" {
  count = var.production_secret_sidecar == null ? 0 : 1
  metadata {
    name      = "wasalx-secret-adapter"
    namespace = kubernetes_namespace.wasalx.metadata[0].name
  }
  automount_service_account_token = false
}

resource "kubernetes_role_v1" "secret_adapter" {
  count = var.production_secret_sidecar == null ? 0 : 1
  metadata {
    name      = "wasalx-secret-adapter"
    namespace = kubernetes_namespace.secret_store[0].metadata[0].name
  }
  rule {
    api_groups = [""]
    resources  = ["secrets"]
    verbs      = ["get", "create", "update", "delete"]
  }
}

resource "kubernetes_role_binding_v1" "secret_adapter" {
  count = var.production_secret_sidecar == null ? 0 : 1
  metadata {
    name      = "wasalx-secret-adapter"
    namespace = kubernetes_namespace.secret_store[0].metadata[0].name
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.secret_adapter[0].metadata[0].name
  }
  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.secret_adapter[0].metadata[0].name
    namespace = kubernetes_namespace.wasalx.metadata[0].name
  }
}
