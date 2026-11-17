#!/usr/bin/env bash
set -euo pipefail

readonly ZAMMAD_VERSION="7.0.3"
readonly ZAMMAD_REVISION="3c049340467b9e7b83a96facf427f2a8e119da54"
readonly ZAMMAD_DOCKERFILE_SHA256="4a97ca1711dbde582ff4b426e189c1973d8473ca33163462942cc949c2435612"
readonly ZAMMAD_REPOSITORY="https://github.com/zammad/zammad.git"
readonly WASALX_PACKAGE_VERSION="0.5.83"
readonly WASALX_PACKAGE_SHA256="00069cb9565f2a9002d5df73cc29532f3adde2fce28f4f09400370f9c9d11153"


workspace_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image_tag="${WASALX_ZAMMAD_COMPAT_IMAGE:-wasalx/zammad:${ZAMMAD_VERSION}-wasalx-${WASALX_PACKAGE_VERSION}-compat}"
worktree_parent=$(mktemp -d "${TMPDIR:-/tmp}/wasalx-zammad-${ZAMMAD_VERSION}.XXXXXX")
worktree="${worktree_parent}/source"
artifact="${workspace_root}/build/zammad/wasalx-${WASALX_PACKAGE_VERSION}.zpm"

cleanup() {
  if [[ "${WASALX_KEEP_ZAMMAD_COMPAT_SOURCE:-0}" == "1" ]]; then
    printf 'kept compatibility source at %s\n' "${worktree}"
  else
    rm -rf "${worktree_parent}"
  fi
}
trap cleanup EXIT

for command in docker git node shasum; do
  command -v "${command}" >/dev/null || {
    printf 'required command is unavailable: %s\n' "${command}" >&2
    exit 1
  }
done

(cd "${workspace_root}" && node scripts/build-zammad-package.mjs)
actual_package_sha=$(shasum -a 256 "${artifact}" | awk '{print $1}')
[[ "${actual_package_sha}" == "${WASALX_PACKAGE_SHA256}" ]] || {
  printf 'WasalX package digest mismatch: %s\n' "${actual_package_sha}" >&2
  exit 1
}

clone_complete=0
for attempt in 1 2 3 4; do
  rm -rf "${worktree}"
  if git -c http.version=HTTP/1.1 clone --quiet --filter=blob:none --depth 1 \
    --branch "${ZAMMAD_VERSION}" "${ZAMMAD_REPOSITORY}" "${worktree}"; then
    clone_complete=1
    break
  fi
  if [[ "${attempt}" -lt 4 ]]; then
    printf 'Zammad checkout attempt %s/4 failed; retrying pinned source\n' "${attempt}" >&2
    sleep "$((attempt * 2))"
  fi
done
if [[ "${clone_complete}" != "1" && -n "${WASALX_GIT_MIRROR_PREFIX:-}" ]]; then
  mirror_repository="${WASALX_GIT_MIRROR_PREFIX%/}/${ZAMMAD_REPOSITORY}"
  for attempt in 1 2; do
    rm -rf "${worktree}"
    if git -c http.version=HTTP/1.1 clone --quiet --filter=blob:none --depth 1 \
      --branch "${ZAMMAD_VERSION}" "${mirror_repository}" "${worktree}"; then
      clone_complete=1
      break
    fi
    if [[ "${attempt}" -lt 2 ]]; then
      printf 'Zammad mirror checkout attempt %s/2 failed; retrying pinned source\n' "${attempt}" >&2
      sleep 2
    fi
  done
fi
[[ "${clone_complete}" == "1" ]] || {
  printf 'Zammad checkout failed after bounded direct and mirror attempts\n' >&2
  exit 1
}
actual_revision=$(git -C "${worktree}" rev-parse HEAD)
[[ "${actual_revision}" == "${ZAMMAD_REVISION}" ]] || {
  printf 'Zammad tag moved: expected %s, received %s\n' "${ZAMMAD_REVISION}" "${actual_revision}" >&2
  exit 1
}

actual_dockerfile_sha=$(shasum -a 256 "${worktree}/Dockerfile" | awk '{print $1}')
[[ "${actual_dockerfile_sha}" == "${ZAMMAD_DOCKERFILE_SHA256}" ]] || {
  printf 'upstream Dockerfile changed: expected %s, received %s\n' \
    "${ZAMMAD_DOCKERFILE_SHA256}" "${actual_dockerfile_sha}" >&2
  exit 1
}

node "${workspace_root}/infra/docker/full/zammad/unpack-zpm.mjs" \
  "${artifact}" "${worktree}" wasalx "${WASALX_PACKAGE_VERSION}"
install -d "${worktree}/contrib" "${worktree}/.wasalx-runtime"
install -m 0644 "${artifact}" "${worktree}/contrib/wasalx.zpm"
install -m 0755 "${workspace_root}/infra/docker/full/zammad/install-package.sh" \
  "${worktree}/.wasalx-runtime/install-package.sh"
install -m 0644 "${workspace_root}/infra/docker/full/zammad/install-package.rb" \
  "${worktree}/.wasalx-runtime/install-package.rb"
install -m 0644 "${workspace_root}/infra/docker/full/zammad/verify-package.rb" \
  "${worktree}/.wasalx-runtime/verify-package.rb"
install -m 0755 "${workspace_root}/infra/docker/full/zammad/bootstrap-runtime.sh" \
  "${worktree}/.wasalx-runtime/bootstrap-runtime.sh"
install -m 0644 "${workspace_root}/infra/docker/full/zammad/bootstrap-runtime.rb" \
  "${worktree}/.wasalx-runtime/bootstrap-runtime.rb"

node "${workspace_root}/scripts/prepare-zammad-previous-stable-image.mjs" \
  "${worktree}" "${ZAMMAD_VERSION}" "${WASALX_PACKAGE_VERSION}" \
  "${WASALX_PACKAGE_SHA256}" "${ZAMMAD_REVISION}" \
  "$(git -C "${workspace_root}" rev-parse HEAD)" \
  "$(git -C "${workspace_root}" rev-parse 'HEAD^{tree}')"

docker build --progress=plain \
  --build-arg "COMMIT_SHA=${ZAMMAD_REVISION}" \
  --build-arg "WASALX_GIT_MIRROR_PREFIX=${WASALX_GIT_MIRROR_PREFIX:-}" \
  --tag "${image_tag}" \
  "${worktree}"

docker image inspect "${image_tag}" --format \
  'built {{.RepoTags}} id={{.Id}} user={{.Config.User}} version={{index .Config.Labels "org.opencontainers.image.version"}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
