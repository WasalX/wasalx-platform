-- Avoid cold JIT compilation for bounded discovery across durable queue backlogs.
-- Preserve the caller's JIT setting, execution budget and scheduler authority.
ALTER FUNCTION app.list_due_worker_tenants(integer) SET jit=off;
