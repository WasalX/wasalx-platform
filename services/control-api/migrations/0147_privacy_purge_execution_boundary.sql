-- Keep direct inbox deletion unavailable to the connector worker.
ALTER FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) SECURITY DEFINER;
ALTER FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) SET row_security=on;
GRANT CREATE ON SCHEMA app TO wasalx_app;
ALTER FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) OWNER TO wasalx_app;
REVOKE CREATE ON SCHEMA app FROM wasalx_app;
REVOKE ALL ON FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) TO wasalx_app,wasalx_connector_worker;
