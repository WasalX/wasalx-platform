#!/bin/sh
set -eu

if output=$(LC_ALL=C apk add --no-cache "$@" 2>&1); then
  printf '%s\n' "$output"
  exit 0
else
  status=$?
fi

printf '%s\n' "$output" >&2
if ! printf '%s\n' "$output" | grep -Fq 'temporary error (try again later)'; then
  exit "$status"
fi

printf '%s\n' 'Temporary APK fetch error; retrying in 2 seconds.' >&2
sleep 2
apk add --no-cache "$@"
