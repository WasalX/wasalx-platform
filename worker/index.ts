/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { observeDuration, recordMetric, safeRequestId, withSpan } from "@wasalx/observability";
import { portalContentSecurityPolicy } from "../lib/portal-security";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const PORTAL_SECURITY_HEADERS = [
  ["Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Strict-Transport-Security", "max-age=31536000"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
] as const;

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const requestId = safeRequestId(request.headers.get("x-request-id"));
    const method = boundedMethod(request.method);
    return withSpan("portal.request", {
      attributes: {
        "wasalx.component": "portal",
        "wasalx.operation": method,
        "wasalx.request_id": requestId,
        "http.request.method": method,
      },
    }, async (span) => {
      let response: Response;
      try {
        const url = new URL(request.url);
        if (url.pathname === "/_vinext/image") {
          const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
          response = await handleImageOptimization(request, {
            fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
            transformImage: async (body, { width, format, quality }) => {
              const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
              return result.response();
            },
          }, allowedWidths);
        } else {
          response = await handler.fetch(request, env, ctx);
        }
      } catch (error) {
        recordMetric("wasalx_http_server_requests_total", 1, { component: "portal", operation: method, status: "5xx" });
        observeDuration("wasalx_http_server_duration_seconds", startedAt, { component: "portal", operation: method, status: "5xx" });
        throw error;
      }
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", portalContentSecurityPolicy(new URL(request.url).pathname));
      headers.set("x-request-id", requestId);
      for (const [name, value] of PORTAL_SECURITY_HEADERS) {
        if (name !== "Referrer-Policy" || headers.get(name) !== "no-referrer") headers.set(name, value);
      }
      const status = statusClass(response.status);
      span.setAttribute("http.response.status_code", response.status);
      recordMetric("wasalx_http_server_requests_total", 1, { component: "portal", operation: method, status });
      observeDuration("wasalx_http_server_duration_seconds", startedAt, { component: "portal", operation: method, status });
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
  },
};

function boundedMethod(value: string) {
  const normalized = value.toUpperCase();
  return new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]).has(normalized)
    ? normalized
    : "OTHER";
}

function statusClass(value: number) {
  return value >= 100 && value <= 599 ? `${Math.floor(value / 100)}xx` : "unknown";
}

export default worker;
