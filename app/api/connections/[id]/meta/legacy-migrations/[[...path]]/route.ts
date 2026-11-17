import { isControlPlaneBackend } from '../../../../../../../lib/backend';
import { metaLegacyMigrationPortalRequest } from '../../../../../../../lib/control-plane-data';
import { authenticatePortalRequest } from '../../../../../../../lib/request-auth';
import { readBoundedJson } from '../../../../../../../lib/bounded-json';
import { parseMetaLegacyMigrationRequest, parseMetaLegacyMigrationActionRequest, parseMetaLegacyMigrationCancelRequest, type MetaLegacyMigrationAction } from '../../../../../../../packages/core/src/meta-legacy-migration-contract';

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
type Context = { params: Promise<{ id: string; path?: string[] }> };
function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store, private, max-age=0', Pragma: 'no-cache' } });
}
async function route(request: Request, context: Context) {
  try {
    const method = request.method === 'GET' ? 'GET' : 'POST';
    const principal = await authenticatePortalRequest(request, method === 'GET' ? 'connection:read' : 'connection:write');
    // A stale open tab must not follow a changed cookie into another actor/workspace.
    // These expected context values never replace authentication or permission checks.
    if (request.headers.get('x-wasalx-legacy-actor') !== encodeURIComponent(principal.userId)
      || request.headers.get('x-wasalx-legacy-workspace') !== encodeURIComponent(principal.tenantId)) return response({ code: 'META_MIGRATION_CONTEXT_CHANGED' }, 403);
    const { id, path = [] } = await context.params;
    const action = path[1];
    const valid = uuid(id) && (method === 'GET'
      ? path.length === 0 || path.length === 1 && uuid(path[0])
      : path.length === 0 || path.length === 1 && path[0] === 'resolve'
        || uuid(path[0]) && (path.length === 2 && ['observe', 'register', 'reconcile', 'cancel'].includes(action)
          || path.length === 3 && ['observe', 'register', 'reconcile'].includes(action) && path[2] === 'resolve'));
    if (!valid) return response({ code: 'NOT_FOUND' }, 404);
    if (new URL(request.url).searchParams.size) return response({ code: 'VALIDATION_ERROR' }, 400);
    if (!isControlPlaneBackend()) return response({ code: 'META_MIGRATION_UNAVAILABLE' }, 501);
    let body: unknown, key: string | undefined;
    if (method === 'POST') {
      const suppliedKey = request.headers.get('idempotency-key');
      if (action !== 'cancel' && !uuid(suppliedKey)) return response({ code: 'VALIDATION_ERROR' }, 400);
      if (action === 'cancel' && suppliedKey !== null) return response({ code: 'VALIDATION_ERROR' }, 400);
      key = suppliedKey ?? undefined;
      try {
        const value: unknown = await readBoundedJson(new Response(request.body, { headers: request.headers }), 4096);
        if (path.length <= 1) body = parseMetaLegacyMigrationRequest(value);
        else if (action === 'cancel') body = parseMetaLegacyMigrationCancelRequest(value);
        else body = parseMetaLegacyMigrationActionRequest(value, action.toUpperCase() as MetaLegacyMigrationAction);
      } catch { return response({ code: 'VALIDATION_ERROR' }, 400); }
    }
    return response(await metaLegacyMigrationPortalRequest(principal, id, path.map(encodeURIComponent).join('/'), method, body, key));
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 503;
    // Do not expose provider messages, request bodies, or raw upstream errors.
    return response({ code: status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'CURRENT_PERMISSION_REQUIRED' : 'META_MIGRATION_UNAVAILABLE' }, status >= 400 && status <= 599 ? status : 503);
  }
}
export const GET = route;
export const POST = route;
