#!/usr/bin/env bash
# Offline only: placeholder digests validate configuration, never qualify images.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
helm=${HELM:-helm}
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
node --input-type=module - "$output/images.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(process.env.WASALX_IMAGE_CATALOG, 'utf8'));
const values = {};
for (const image of [...catalog.images, { ...catalog.productionSecretSidecar, repository: 'secret-sidecar' }]) {
  for (const path of image.helmPaths) {
    const parts = path.split('.');
    let target = values;
    for (const key of parts.slice(0, -1)) target = target[key] ??= {};
    target[parts.at(-1)] = `${process.env.WASALX_IMAGE_REGISTRY ?? (() => { throw new Error("WASALX_IMAGE_REGISTRY is required"); })()}/${image.repository}@sha256:${'0'.repeat(64)}`;
  }
}
writeFileSync(process.argv[2], JSON.stringify(values));
JS
args=(wasalx infra/helm/wasalx --namespace "${WASALX_PRODUCTION_NAMESPACE:?Set WASALX_PRODUCTION_NAMESPACE}" --values "${WASALX_PRODUCTION_VALUES:?Set WASALX_PRODUCTION_VALUES}" --values "$output/images.json")
"$helm" template "${args[@]}" > "$output/rendered.yaml"
ruby scripts/validate-secret-adapter-render.rb "$output/rendered.yaml"
python3 "${WASALX_PRODUCTION_MIGRATION_CHECK:?Set WASALX_PRODUCTION_MIGRATION_CHECK}" "$output/rendered.yaml"
ruby scripts/validate-production-foundation.rb "${WASALX_FOUNDATION_MANIFEST:?Set WASALX_FOUNDATION_MANIFEST}"
ruby scripts/validate-cloudflared-manifest.rb
# These invalid variants reproduce real deployment failures and trust boundaries.
for invalid in \
  'managedWaha.gows.image=' \
  'media.s3.kmsKeyId=invalid-for-managed-encryption' \
  'productionSecretSidecar.credentialsSecretName=' \
  'productionSecretSidecar.tlsSecretName=' \
  'productionSecretSidecar.caConfigMapName='; do
  if "$helm" template "${args[@]}" --set-string "$invalid" > "$output/invalid.log" 2>&1; then
    printf 'Production preflight accepted invalid configuration: %s\n' "$invalid" >&2
    exit 1
  fi
done
printf 'Committed production configuration and rejection cases verified offline.\n'
