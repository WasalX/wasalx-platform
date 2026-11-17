import { supportDecision } from "../../_decision";

export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return supportDecision(request, context, "approve");
}
