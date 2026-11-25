#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ ! -L "$repo_root/.zammad-addon" ]] || { echo "Add-on root must not be a symlink" >&2; exit 2; }
cd "$repo_root/.zammad-addon"
[[ -d .git && -z "$(git rev-parse --show-prefix)" ]] || { echo "Expected add-on repository root" >&2; exit 2; }
expected_commit="$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{40}$/.test(p.commit))process.exit(2);process.stdout.write(p.commit)' "$repo_root/zammad-addon.json")"
[[ "$(git rev-parse HEAD)" == "$expected_commit" ]] || { echo "Add-on HEAD does not match the pinned commit" >&2; exit 2; }

if [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "Refusing to build corresponding source from a dirty tree." >&2
  exit 2
fi

version="$(node -p "JSON.parse(require('fs').readFileSync('zammad-package/package-source.json','utf8')).version")"
commit="$(git rev-parse --verify HEAD)"
output_dir="$repo_root/build/source"
archive="$output_dir/wasalx-zammad-${version}-source-${commit}.tar.gz"
checksum="$archive.sha256"

mkdir -p "$output_dir"
if [[ -e "$archive" || -e "$checksum" ]]; then
  echo "Refusing to overwrite an existing corresponding-source artifact." >&2
  exit 3
fi

git -c core.autocrlf=false archive --format=tar.gz --prefix="wasalx-${version}/" --output="$archive" "$commit"
(
  cd "$output_dir"
  node -e 'const fs=require("node:fs"),crypto=require("node:crypto"),p=process.argv[1];console.log(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p)' "$(basename "$archive")" > "$(basename "$checksum")"
)

printf '%s\n' "$archive"
printf '%s\n' "$checksum"
