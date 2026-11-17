import { wahaAuthorizationRoute } from "../../../_authorization";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return wahaAuthorizationRoute(request, context, "passkey");
}
