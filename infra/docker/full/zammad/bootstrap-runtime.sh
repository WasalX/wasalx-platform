#!/usr/bin/env bash

set -o errexit -o nounset -o pipefail

cd /opt/zammad
exec bundle exec rails runner /usr/local/lib/wasalx/bootstrap-runtime.rb
