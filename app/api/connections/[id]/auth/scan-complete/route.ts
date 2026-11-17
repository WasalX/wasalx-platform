import { wahaAuthorizationRoute } from "../../../_authorization";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return wahaAuthorizationRoute(request, context, "scan-complete");
}
