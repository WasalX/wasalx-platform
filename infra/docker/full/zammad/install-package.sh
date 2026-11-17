#!/usr/bin/env bash
set -euo pipefail

cd /opt/zammad
/opt/zammad/bin/rails runner /usr/local/lib/wasalx/install-package.rb
/opt/zammad/bin/rake zammad:package:migrate
/opt/zammad/bin/rake zammad:package:verify
/opt/zammad/bin/rails runner /usr/local/lib/wasalx/verify-package.rb
