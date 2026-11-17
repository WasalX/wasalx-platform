import {
  authenticatePlatformPortalRequest,
  platformAuthErrorResponse,
} from "../../../../lib/platform-request-auth";
import { allowedPlatformProxyRoute } from "../../../../lib/platform-proxy-routes";
import { BoundedBodyError, readBoundedBody } from "../../../../lib/bounded-json";

import { platformOperatorRecoveryScope } from "../../../../lib/platform-operator-recovery-scope.ts";
import { platformOidcConfiguration } from "../../../../lib/platform-oidc.ts";
import { parseMetaTransitionOperatorRequest, type MetaTransitionOperatorAction } from "../../../../packages/core/src/meta-transition-operator-contract.ts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

export function GET(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export function POST(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export function PUT(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export function PATCH(request: Request, context: RouteContext) {
  return proxy(request, context);
}

async function proxy(request: Request, context: RouteContext) {
  let forwarded=false;
  try {
    const session = await authenticatePlatformPortalRequest(request);
    const { path } = await context.params;
    const normalizedPath = path.join("/");
    if (!allowedPlatformProxyRoute(request.method, normalizedPath)) {
      return Response.json({ error: "Platform operation is not available" }, { status: 404 });
    }
    const configuration = controlApiConfiguration();
    const incomingUrl = new URL(request.url);
    const target = new URL(`/platform/v1/${normalizedPath}`, configuration.baseUrl);
    if (incomingUrl.search.length > 1_024) {
      return Response.json({ error: "Platform query is too large" }, { status: 400 });
    }
    const transitionReview = /^operations\/tenants\/[^/]+\/meta\/account-transitions(?:\/|$)/u.test(normalizedPath);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (transitionReview) {
      const scope = await platformOperatorRecoveryScope(platformOidcConfiguration().issuer, session.subject);
      if (request.headers.get("x-wasalx-platform-recovery-scope") !== scope) return Response.json({ error: "Platform operator context changed" }, { status: 403, headers: { "cache-control": "no-store" } });
      const keys = [...incomingUrl.searchParams.keys()];
      if (keys.length && (request.method !== "GET" || !normalizedPath.endsWith("/review") || keys.length !== 1 || keys[0] !== "requestKey" || !uuid.test(incomingUrl.searchParams.get("requestKey") ?? ""))) return Response.json({ error: "Invalid review query" }, { status: 400 });
    }
    target.search = incomingUrl.search;
    let body: string | undefined;
    if (!["GET", "HEAD"].includes(request.method)) {
      const isStatement = /^meta-costs\/tenants\/[0-9a-f-]{36}\/statements(?:\/[0-9a-f-]{36}\/(?:review|preview|publish|reconcile-source|privacy-review))?$/iu.test(normalizedPath);
      const bytes = await readBoundedBody(request, isStatement ? 524_288 : 65_536, 30_000);
      try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return Response.json({ error: "Request text is invalid" }, { status: 400, headers: { "cache-control": "no-store" } }); }
      if (transitionReview) {
        if (!uuid.test(request.headers.get("idempotency-key") ?? "")) return Response.json({ error: "Review request key is required" }, { status: 400 });
        let input: unknown;
        try { input = JSON.parse(body); }
        catch { return Response.json({ error: "Invalid review body" }, { status: 400 }); }
        const segments = normalizedPath.split("/");
        const action = (segments.at(-1) === "resolve" ? segments.at(-2)! : segments.at(-1)!).toUpperCase() as MetaTransitionOperatorAction;
        const parsed = parseMetaTransitionOperatorRequest(action, input);
        if (!parsed) return Response.json({ error: "Invalid review body" }, { status: 400 });
        body = JSON.stringify(parsed);
      }
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    forwarded=true;
    const response = await fetch(target, {
      method: request.method,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = /^meta-costs\/tenants\/[0-9a-f-]{36}\/statements(?:\/|$)/iu.test(normalizedPath)
      ? new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(response, 10_485_760, 15_000))
      : await response.text();
    return new Response(responseBody || null, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (forwarded) return Response.json({ error: "Platform response is unavailable; reconcile the original operation" }, { status: 502, headers: { "cache-control": "no-store" } });
    if (error instanceof BoundedBodyError) return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    return platformAuthErrorResponse(error);
  }
}

function controlApiConfiguration() {
  const raw = process.env.CONTROL_API_URL;
  if (!raw) throw new Error("CONTROL_API_URL is required");
  const baseUrl = new URL(raw);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  return { baseUrl };
}
