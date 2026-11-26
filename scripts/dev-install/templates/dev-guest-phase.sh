#!/usr/bin/env bash
set -euo pipefail
umask 077
phase="$1"
state="$2"
# shellcheck source=/dev/null
source "$state/host.env"
# shellcheck source=/dev/null
source "$state/dev-step-lock.sh"
hold_dev_step_lock "$(cat "$state/run-id")" "guest-$phase"
P="$STAGING"
ssh_guest=(ssh -F /dev/null -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$GUEST_KNOWN_HOSTS" -o ConnectTimeout=12 -i "$GUEST_KEY"
  -p "$GUEST_PORT" "$GUEST_USER@$GUEST_ADDRESS")
stamp() { printf 'GUEST_STEP name=%s event=%s at=%s\n' "$1" "$2" "$(date -u +%FT%TZ)"; }
stamp ssh-ready start
deadline=$((SECONDS+180))
until "${ssh_guest[@]}" true </dev/null >/dev/null 2>&1; do
  test "$SECONDS" -lt "$deadline" || exit 75
  sleep 5
done
test "$("${ssh_guest[@]}" hostname </dev/null)" = "$GUEST_HOSTNAME"
stamp ssh-ready pass
stamp guard start
payload="$(base64 -w0 -- "$P/guard-closed.py")"
"${ssh_guest[@]}" "printf %s '$payload' | base64 -d | sudo -n env WASALX_INSTALL_EXPECTED_HOSTNAME=$GUEST_HOSTNAME WASALX_DEV_REVIEW_ORIGIN_SUFFIX=$REVIEW_SUFFIX python3 -B" \
  </dev/null | grep -Fx 'GUARD_AND_CLOSED=PASS'
stamp guard pass
stamp docker-ready start
deadline=$((SECONDS+300))
until "${ssh_guest[@]}" 'sudo -n docker info --format "{{.ServerVersion}}"' </dev/null >/dev/null 2>&1; do
  test "$SECONDS" -lt "$deadline" || exit 75
  sleep 5
done
stamp docker-ready pass
pre_arm_sha256() {
  local marker
  marker="$(grep -Ex 'PRE_ARM_RECREATABILITY=PASS sha256=[a-f0-9]{64} services=(none|keycloak-bootstrap|zammad-runtime-bootstrap|keycloak-bootstrap,zammad-runtime-bootstrap)' "$state/pre-arm-preflight.log")"
  [[ "$marker" != *$'\n'* ]] || return 75
  [[ "$marker" =~ ^PRE_ARM_RECREATABILITY=PASS\ sha256=([a-f0-9]{64})\ services= ]] || return 75
  printf '%s\n' "${BASH_REMATCH[1]}"
}
case "$phase" in
prove|preflight)
  stamp held-readback start
  payload="$(base64 -w0 -- "$P/old-held-readback.py")"
  "${ssh_guest[@]}" "printf %s '$payload' | base64 -d | sudo -n python3 -I -B -" </dev/null
  stamp held-readback pass
  if [ "$phase" = preflight ]; then
    bash "$P/transfer.sh" checkout | tee "$state/transfer-checkout.log"
    grep -Fqx 'GUEST_CHECKOUT=PASS exact_commit_tree_clean=true' "$state/transfer-checkout.log"
    "${ssh_guest[@]}" "sudo -n /usr/bin/python3 -I -B $GUEST_RUN_SCRIPT --pre-arm-preflight" \
      </dev/null | tee "$state/pre-arm-preflight.log"
    grep -Fqx 'PRE_ARM_NATIVE_PREFLIGHT=PASS stock_bind_mount_readability=true running_dev_state=true' "$state/pre-arm-preflight.log"
    pre_arm_sha256 >/dev/null
    grep -Eq "^DATA_VOLUME_COVERAGE=PASS source=${GUEST_VOLUME_SOURCE} volumes=[1-9][0-9]*$" "$state/pre-arm-preflight.log"
  fi
  ;;
install)
  bash "$P/transfer.sh" install | tee "$state/transfer.log"
  pre_arm_sha="$(pre_arm_sha256)"
  "${ssh_guest[@]}" "sudo -n /usr/bin/python3 -I -B $GUEST_RUN_SCRIPT --pre-arm-sha256 $pre_arm_sha" \
    </dev/null | tee "$state/guest-signed.log"
  grep -Eq '^BOOTSTRAP_RECREATE=PASS services=(none|keycloak-bootstrap|zammad-runtime-bootstrap|keycloak-bootstrap,zammad-runtime-bootstrap)$' "$state/guest-signed.log"
  grep -Fqx 'BOOTSTRAP_NON_EFFECTS=PASS unchanged_ids_and_started_at=3' "$state/guest-signed.log"
  grep -Fqx 'GUEST_HELD_INSTALL=PASS both_shipped_fences=PASS mailer=no/0/max1 release=HELD' "$state/guest-signed.log"
  /usr/bin/python3 -I -B "$state/probe-up.py" | tee "$state/portal-readiness.log"
  grep -Fqx 'PORTAL_HTTPS_READY=PASS' "$state/portal-readiness.log"
  stamp held-readback start
  payload="$(base64 -w0 -- "$P/old-held-readback.py")"
  "${ssh_guest[@]}" "printf %s '$payload' | base64 -d | sudo -n env EXPECT_NEVER_STARTED=1 python3 -I -B -" </dev/null
  stamp held-readback pass
  ;;
*) exit 75 ;;
esac
finish_dev_step "$state"
