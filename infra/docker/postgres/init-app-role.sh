#!/bin/sh
set -eu
: "${WASALX_APP_PASSWORD:?WASALX_APP_PASSWORD is required}"
: "${WASALX_CONNECTOR_WORKER_DB_PASSWORD:?WASALX_CONNECTOR_WORKER_DB_PASSWORD is required}"
: "${WASALX_SECRET_CLEANUP_DB_PASSWORD:?WASALX_SECRET_CLEANUP_DB_PASSWORD is required}"
: "${WASALX_PROVISIONING_DB_PASSWORD:?WASALX_PROVISIONING_DB_PASSWORD is required}"
: "${WASALX_SUPPORT_DB_PASSWORD:?WASALX_SUPPORT_DB_PASSWORD is required}"
: "${WASALX_WAHA_REGISTRY_DB_PASSWORD:?WASALX_WAHA_REGISTRY_DB_PASSWORD is required}"
: "${WASALX_WAHA_OPERATOR_DB_PASSWORD:?WASALX_WAHA_OPERATOR_DB_PASSWORD is required}"
: "${WASALX_WAHA_ROLLOUT_GATE_DB_PASSWORD:?WASALX_WAHA_ROLLOUT_GATE_DB_PASSWORD is required}"
: "${WASALX_INVITATION_MAILER_DB_PASSWORD:?WASALX_INVITATION_MAILER_DB_PASSWORD is required}"
: "${WASALX_IDENTITY_POLICY_DB_PASSWORD:?WASALX_IDENTITY_POLICY_DB_PASSWORD is required}"
: "${WASALX_METERING_INGEST_DB_PASSWORD:?WASALX_METERING_INGEST_DB_PASSWORD is required}"
: "${WASALX_PLATFORM_OPERATIONS_DB_PASSWORD:?WASALX_PLATFORM_OPERATIONS_DB_PASSWORD is required}"

attempt=1
while [ "$attempt" -le 10 ]; do
  # The same script runs during first-cluster initialization and as the bounded
  # startup reconciler. PostgreSQL can report healthy just before an init-time
  # role transaction releases its locks, so retry the complete idempotent role
  # transaction rather than letting a transient collision fail the stack.
  if psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv app_password WASALX_APP_PASSWORD
\getenv connector_worker_password WASALX_CONNECTOR_WORKER_DB_PASSWORD
\getenv cleanup_password WASALX_SECRET_CLEANUP_DB_PASSWORD
\getenv provisioning_password WASALX_PROVISIONING_DB_PASSWORD
\getenv support_password WASALX_SUPPORT_DB_PASSWORD
\getenv waha_registry_password WASALX_WAHA_REGISTRY_DB_PASSWORD
\getenv waha_operator_password WASALX_WAHA_OPERATOR_DB_PASSWORD
\getenv waha_rollout_gate_password WASALX_WAHA_ROLLOUT_GATE_DB_PASSWORD
\getenv invitation_mailer_password WASALX_INVITATION_MAILER_DB_PASSWORD
\getenv identity_policy_password WASALX_IDENTITY_POLICY_DB_PASSWORD
\getenv metering_ingest_password WASALX_METERING_INGEST_DB_PASSWORD
\getenv platform_operations_password WASALX_PLATFORM_OPERATIONS_DB_PASSWORD
SELECT 'CREATE ROLE wasalx_app NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_app')\gexec
SELECT format('CREATE ROLE wasalx_runtime LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_runtime')\gexec
SELECT format('ALTER ROLE wasalx_runtime LOGIN PASSWORD %L', :'app_password')\gexec
GRANT wasalx_app TO wasalx_runtime;
SELECT 'CREATE ROLE wasalx_connector_worker NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_connector_worker')\gexec
SELECT format('CREATE ROLE wasalx_connector_worker_runtime LOGIN PASSWORD %L', :'connector_worker_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_connector_worker_runtime')\gexec
SELECT format('ALTER ROLE wasalx_connector_worker_runtime LOGIN PASSWORD %L', :'connector_worker_password')\gexec
REVOKE wasalx_app FROM wasalx_connector_worker_runtime;
GRANT wasalx_connector_worker TO wasalx_connector_worker_runtime;
SELECT 'CREATE ROLE wasalx_secret_cleanup_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_secret_cleanup_client')\gexec
SELECT format('CREATE ROLE wasalx_secret_cleanup_runtime LOGIN PASSWORD %L', :'cleanup_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_secret_cleanup_runtime')\gexec
SELECT format('ALTER ROLE wasalx_secret_cleanup_runtime LOGIN PASSWORD %L', :'cleanup_password')\gexec
GRANT wasalx_secret_cleanup_client TO wasalx_secret_cleanup_runtime;
SELECT 'CREATE ROLE wasalx_provisioning_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_provisioning_client')\gexec
SELECT format('CREATE ROLE wasalx_provisioning_runtime LOGIN PASSWORD %L', :'provisioning_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_provisioning_runtime')\gexec
SELECT format('ALTER ROLE wasalx_provisioning_runtime LOGIN PASSWORD %L', :'provisioning_password')\gexec
GRANT wasalx_provisioning_client TO wasalx_provisioning_runtime;
SELECT format('CREATE ROLE wasalx_support_runtime LOGIN PASSWORD %L', :'support_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_support_runtime')\gexec
SELECT format('ALTER ROLE wasalx_support_runtime LOGIN PASSWORD %L', :'support_password')\gexec
SELECT 'CREATE ROLE wasalx_support_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_support_client')\gexec
GRANT wasalx_support_client TO wasalx_support_runtime;
SELECT 'CREATE ROLE wasalx_waha_registry_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_waha_registry_client')\gexec
SELECT format('CREATE ROLE wasalx_waha_registry_runtime LOGIN PASSWORD %L', :'waha_registry_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_waha_registry_runtime')\gexec
SELECT format('ALTER ROLE wasalx_waha_registry_runtime LOGIN PASSWORD %L', :'waha_registry_password')\gexec
GRANT wasalx_waha_registry_client TO wasalx_waha_registry_runtime;
SELECT 'CREATE ROLE wasalx_waha_operator_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_waha_operator_client')\gexec
SELECT format('CREATE ROLE wasalx_waha_operator_runtime LOGIN PASSWORD %L', :'waha_operator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_waha_operator_runtime')\gexec
SELECT format('ALTER ROLE wasalx_waha_operator_runtime LOGIN PASSWORD %L', :'waha_operator_password')\gexec
GRANT wasalx_waha_operator_client TO wasalx_waha_operator_runtime;
SELECT 'CREATE ROLE wasalx_waha_rollout_gate_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_waha_rollout_gate_client')\gexec
SELECT format('CREATE ROLE wasalx_waha_rollout_gate_runtime LOGIN PASSWORD %L', :'waha_rollout_gate_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_waha_rollout_gate_runtime')\gexec
SELECT format('ALTER ROLE wasalx_waha_rollout_gate_runtime LOGIN PASSWORD %L', :'waha_rollout_gate_password')\gexec
GRANT wasalx_waha_rollout_gate_client TO wasalx_waha_rollout_gate_runtime;
SELECT 'CREATE ROLE wasalx_invitation_mailer NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_invitation_mailer')\gexec
SELECT format('CREATE ROLE wasalx_invitation_mailer_runtime LOGIN PASSWORD %L', :'invitation_mailer_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_invitation_mailer_runtime')\gexec
SELECT format('ALTER ROLE wasalx_invitation_mailer_runtime LOGIN PASSWORD %L', :'invitation_mailer_password')\gexec
GRANT wasalx_invitation_mailer TO wasalx_invitation_mailer_runtime;
SELECT 'CREATE ROLE wasalx_identity_policy_activator NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_identity_policy_activator')\gexec
SELECT format('CREATE ROLE wasalx_identity_policy_runtime LOGIN PASSWORD %L', :'identity_policy_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_identity_policy_runtime')\gexec
SELECT format('ALTER ROLE wasalx_identity_policy_runtime LOGIN PASSWORD %L', :'identity_policy_password')\gexec
GRANT wasalx_identity_policy_activator TO wasalx_identity_policy_runtime;
SELECT 'CREATE ROLE wasalx_metering_ingest_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_metering_ingest_client')\gexec
SELECT format('CREATE ROLE wasalx_metering_ingest_runtime LOGIN PASSWORD %L', :'metering_ingest_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_metering_ingest_runtime')\gexec
SELECT format('ALTER ROLE wasalx_metering_ingest_runtime LOGIN PASSWORD %L', :'metering_ingest_password')\gexec
GRANT wasalx_metering_ingest_client TO wasalx_metering_ingest_runtime;
SELECT 'CREATE ROLE wasalx_platform_operations_client NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_platform_operations_client')\gexec
SELECT format('CREATE ROLE wasalx_platform_operations_runtime LOGIN PASSWORD %L', :'platform_operations_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_platform_operations_runtime')\gexec
SELECT format('ALTER ROLE wasalx_platform_operations_runtime LOGIN PASSWORD %L', :'platform_operations_password')\gexec
GRANT wasalx_platform_operations_client TO wasalx_platform_operations_runtime;
SQL
  then
    exit 0
  fi
  if [ "$attempt" -eq 10 ]; then
    echo "Runtime database role reconciliation failed after 10 attempts" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done
