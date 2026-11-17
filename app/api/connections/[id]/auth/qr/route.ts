import { wahaAuthorizationRoute } from "../../../_authorization";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return wahaAuthorizationRoute(request, context, "qr");
}
