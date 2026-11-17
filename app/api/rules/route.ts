import { NextResponse } from "next/server";
import { createRule } from "../../../lib/data";
import type { TriggerRule } from "../../../lib/domain";
import { isControlPlaneBackend } from "../../../lib/backend";
import { authenticatePortalRequest, authErrorResponse } from "../../../lib/request-auth";

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(request,"rule:write");
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!idempotencyKey || idempotencyKey.length > 255) return NextResponse.json({ error: "A valid idempotency key is required." }, { status: 400 });
    const body = await request.json() as Omit<TriggerRule,"id"|"matchCount"|"version"> & {
      savedExamples?: Array<{ name:string; message:string; expectedMatches:string[]; sender?: "team" | "customer" | "unknown" }>;
    };
    if (!body.name?.trim() || !body.pattern?.trim()) return NextResponse.json({ error: "Name and expression are required." }, { status: 400 });
    if (!isControlPlaneBackend() && body.matcherType === "advanced") return NextResponse.json({ error: "Advanced expression creation requires the Node control plane and its safe RE2 tester." }, { status: 422 });
    const id = await createRule(body, principal.displayName, idempotencyKey);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) { try{return authErrorResponse(error)}catch{return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid rule." }, { status: 400 })} }
}
