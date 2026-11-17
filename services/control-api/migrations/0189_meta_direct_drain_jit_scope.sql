-- Avoid JIT compilation overhead for the bounded drain's repeated point-lookups.
-- Keep the caller's JIT setting, execution budget and validation fences intact.
ALTER FUNCTION app.drain_meta_direct_transitions(uuid,uuid,boolean) SET jit=off;
