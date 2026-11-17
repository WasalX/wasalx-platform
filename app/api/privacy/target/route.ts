import { isControlPlaneBackend, isFixtureBackend } from "../../../../lib/backend";
import { readBoundedBody } from "../../../../lib/bounded-json";
import { resolvePrivacyTarget } from "../../../../lib/control-plane-data";
import { authenticatePortalRequest, authErrorResponse, requirePermission } from "../../../../lib/request-auth";

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request, "privacy:read");
    // Owners/administrators may select targets; auditors cannot enumerate identities.
    requirePermission(principal, "privacy:export");
    if (!isControlPlaneBackend() && !isFixtureBackend()) return Response.json({ error: "Target selection is unavailable" }, { status: 503 });
    const bytes = await readBoundedBody(request, 2048, 5_000);
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "scopeType,scopeValue"
      || !("scopeType" in body) || typeof body.scopeType !== "string" || !["ZAMMAD_TICKET", "ZAMMAD_USER"].includes(body.scopeType)
      || !("scopeValue" in body) || typeof body.scopeValue !== "string" || body.scopeValue.length > 320)
      return Response.json({ error: "Choose a case or customer" }, { status: 400 });
    const input = { scopeType: body.scopeType, scopeValue: body.scopeValue };
    const selected = isFixtureBackend() ? await (await import("../../../../lib/fixture-data")).resolvePrivacyTarget(input, principal.role) : await resolvePrivacyTarget(input);
    return Response.json(selected,
      { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid target selection" }, { status: 400 });
    return authErrorResponse(error);
  }
}
