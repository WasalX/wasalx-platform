#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! "$1" =~ ^[a-f0-9]{64}$ || ! "$2" =~ ^[a-f0-9]{64}$ ||
  "$1" != "${WASALX_KEYCLOAK_EXPECTED_CONTAINER_ID:-}" || "$1" == "$2" ]]; then
  echo 'Keycloak bootstrap container IDs failed pre-start validation.' >&2
  exit 75
fi

keycloak_id="$1"
bootstrap_id="$2"
format='{{.Id}} {{.State.Status}} {{.HostConfig.NetworkMode}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "WASALX_KEYCLOAK_BOOTSTRAP_MODE"}}{{if eq . "WASALX_KEYCLOAK_BOOTSTRAP_MODE=preserve-existing"}} preserve-existing{{else}} invalid-mode{{end}}{{end}}{{end}}'
if ! binding="$(docker inspect --type container --format "$format" "$bootstrap_id" 2>/dev/null)" ||
  [[ "$binding" != "$bootstrap_id created container:$keycloak_id preserve-existing" ]]; then
  echo 'Keycloak bootstrap failed pre-start network or preserve-mode validation.' >&2
  exit 75
fi
