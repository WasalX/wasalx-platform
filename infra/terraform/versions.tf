terraform {
  required_version = ">= 1.10.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.14"
    }
  }
  backend "s3" {
    key          = "wasalx/control-plane.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
