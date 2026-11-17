-- Both readers return at most one row; the default 1000-row estimate multiplies
-- their lateral joins and triggers expensive JIT compilation for a point lookup.
ALTER FUNCTION app.meta_direct_routing_guard(uuid,uuid,text,text,uuid,text,jsonb,bigint,uuid[],uuid,boolean) ROWS 1;
ALTER FUNCTION app.current_waha_session_runtime(uuid) ROWS 1;
