#!/usr/bin/env bash
set -euo pipefail

# Compare the exact test merge with its base parent. Unknown paths require images.
# Do not detect renames: taking a file out of the image context changes its inputs.
git diff --quiet --no-ext-diff --no-renames HEAD^1 HEAD -- . \
  ':(exclude)README.md' ':(exclude)docs/**' \
  ':(exclude).github/workflows/deploy.yml' ':(exclude).github/dependabot.yml' \
  ':(exclude)scripts/hosted-ci*.mjs' ':(exclude)scripts/hosted-ci*.json' \
  ':(exclude)scripts/test-unit.mjs' ':(exclude)tests/hosted-ci.test.mjs'
