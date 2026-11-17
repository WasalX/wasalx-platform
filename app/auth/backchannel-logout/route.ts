import { BoundedBodyError, readBoundedBody } from "../../../lib/bounded-json";
import { OidcLogoutError, verifyOidcLogoutToken } from "../../../lib/oidc";
import { recordOidcLogout } from "../../../lib/portal-session-store";

// This signed IdP endpoint deliberately does not accept browser-cookie authentication.
export async function POST(request: Request) {
  try {
    if ((request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/x-www-form-urlencoded")
      throw new OidcLogoutError();
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 32_768)) throw new OidcLogoutError();
    const bytes = await readBoundedBody(request, 32_768, 5_000);
    let form: URLSearchParams;
    try { form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new OidcLogoutError(); }
    const values = form.getAll("logout_token");
    if (values.length !== 1 || !values[0]) throw new OidcLogoutError();
    await recordOidcLogout(await verifyOidcLogoutToken(values[0]));
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const invalid = error instanceof BoundedBodyError || error instanceof OidcLogoutError && error.status === 400;
    return Response.json({ error: invalid ? "invalid_request" : "temporarily_unavailable" }, {
      status: invalid ? 400 : 503, headers: { "cache-control": "no-store" },
    });
  }
}
