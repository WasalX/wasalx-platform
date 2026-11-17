import { lifecycleRoute } from "../../_lifecycle";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return lifecycleRoute(
    request,
    context,
    "disconnect",
    "connection:disconnect",
  );
}
