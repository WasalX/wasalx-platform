import { NextResponse } from "next/server";
import { isFixtureBackend } from "../../../../../lib/backend";
import { enqueueZammadOutbound } from "../../../../../lib/data";
import { ServiceAuthenticationError, verifyServiceJwt } from "../../../../../packages/core/src/service-auth";

export async function POST(request: Request) {
  if (!isFixtureBackend()) return unavailable();
  try {
    const secret = process.env.ZAMMAD_SERVICE_JWT_SECRET;
    if (!secret) return NextResponse.json({ error: "Service authentication unavailable" }, { status: 503 });
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "Bearer token required" }, { status: 401 });
    const claims = await verifyServiceJwt(token, secret, { audience: "wasalx-control", scope: "zammad:outbound" });
    const body = await request.json() as {
      tenant_id?: string;
      connection_id?: string;
      group_id?: string;
      ticket_id?: string | number;
      article_id?: string | number;
      body?: string;
      content_type?: string;
      reply_to_message_id?: string;
      idempotency_key?: string;
      internal?: boolean;
    };
    if (body.tenant_id !== claims.tenant_id) return NextResponse.json({ error: "Tenant mismatch" }, { status: 403 });
    if (body.internal) return NextResponse.json({ error: "Internal notes are never communicative" }, { status: 422 });
    if (!body.connection_id || !body.group_id || body.ticket_id == null || body.article_id == null || !body.body || !body.idempotency_key) {
      return NextResponse.json({ error: "Missing outbound delivery fields" }, { status: 400 });
    }
    if (body.body.length > 65_536) return NextResponse.json({ error: "Message is too large" }, { status: 413 });
    const result = await enqueueZammadOutbound({
      tenantId: claims.tenant_id,
      connectionId: body.connection_id,
      groupId: body.group_id,
      ticketId: String(body.ticket_id),
      articleId: String(body.article_id),
      body: body.body,
      contentType: body.content_type ?? "text/plain",
      replyToMessageId: body.reply_to_message_id,
      idempotencyKey: body.idempotency_key,
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof ServiceAuthenticationError) return NextResponse.json({ error: error.message }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Outbound request failed" }, { status: 400 });
  }
}

function unavailable() {
  return NextResponse.json({ error: "Zammad ingress is not exposed by the portal" }, { status: 404 });
}
