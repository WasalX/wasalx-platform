import { isControlPlaneBackend } from "../../../../lib/backend";
import {
  FixtureRuleTestError,
  testFixtureRules,
} from "../../../../lib/fixture-rule-tester";
import type { RuleTestRequest } from "../../../../lib/rule-test-contract";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../../lib/request-auth";

export async function POST(request: Request) {
  try {
    await authenticatePortalRequest(request, "rule:read");
    const body = await request.json() as RuleTestRequest;
    const result = isControlPlaneBackend()
      ? await (await import("../../../../lib/control-plane-data")).testRulesAtControlPlane(body)
      : testFixtureRules(body);
    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof FixtureRuleTestError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    try {
      return authErrorResponse(error);
    } catch {
      return Response.json(
        { error: error instanceof Error ? error.message : "Rule test failed." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  }
}
