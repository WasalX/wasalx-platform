#!/bin/sh
set -eu

# Local integration evidence only. Production object-store protection is a
# separate live provider gate documented in the disaster-recovery runbook.
: "${MC_HOST_local:?MC_HOST_local is required}"

mc mb --ignore-existing local/wasalx-media local/waha-media

for bucket in wasalx-media waha-media; do
  mc version enable "local/${bucket}"
  mc ilm rule import "local/${bucket}" < /bootstrap/noncurrent-lifecycle.json
done

# Fail closed if either idempotent mutation did not take effect. Keep the
# checks machine-readable enough for Compose logs and operator evidence.
for bucket in wasalx-media waha-media; do
  version_info="$(mc version info "local/${bucket}" --json)"
  case "${version_info}" in
    *'"status"'*'"Enabled"'*) ;;
    *) echo "Versioning verification failed for ${bucket}" >&2; exit 1 ;;
  esac

  lifecycle_info="$(mc ilm rule ls --json "local/${bucket}")"
  case "${lifecycle_info}" in
    *wasalx-noncurrent-retention*) ;;
    *) echo "Lifecycle verification failed for ${bucket}" >&2; exit 1 ;;
  esac
done
