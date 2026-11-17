import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../../../../lib/backend";
import { getMetaNumberRelease, requestMetaNumberRelease } from "../../../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse } from "../../../../../../lib/request-auth";
import { BoundedBodyError, readBoundedJson } from "../../../../../../lib/bounded-json";

type Context = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "no-store, private, max-age=0", Pragma: "no-cache" };
function connectionId(value: string) {
  if (value.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) throw Object.assign(new Error("Invalid connection"), { status: 400 });
  return value;
}
export async function GET(request: Request, context: Context) {
  try {
    await authenticatePortalRequest(request, "connection:read");
    const id = connectionId((await context.params).id);
    if (!isControlPlaneBackend()) return NextResponse.json({ error: "Number release requires the persistent backend." }, { status: 501, headers });
    return NextResponse.json(await getMetaNumberRelease(id), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    await authenticatePortalRequest(request, "connection:disconnect");
    const id = connectionId((await context.params).id);
    if (!isControlPlaneBackend()) return NextResponse.json({ error: "Number release requires the persistent backend." }, { status: 501, headers });
    const key = request.headers.get("idempotency-key");
    if (!key || key.length > 128 || key.trim() !== key || /\p{Cc}/u.test(key)) return NextResponse.json({ error: "Request key is invalid." }, { status: 400, headers });
    let body: unknown;
    try { body = await readBoundedJson(new Response(request.body, { headers: request.headers }), 4096); }
    catch (error) {
      return NextResponse.json({ error: "Review the number release details.", code: "META_NUMBER_RELEASE_INVALID" }, {
        status: error instanceof BoundedBodyError ? error.status : 400, headers,
      });
    }
    return NextResponse.json(await requestMetaNumberRelease(id, key, body, request.headers.get("origin")!), { headers });
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  const response = authErrorResponse(error);
  Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}
