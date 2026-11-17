import { NextResponse } from "next/server";
import { isFixtureBackend } from "../../../lib/backend";
import { acceptProviderEvent } from "../../../lib/data";
import { verifyHmac } from "../../../packages/core/src/security";

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export async function GET(request: Request) {
  if (!isFixtureBackend()) return unavailable();
  const env = process.env;
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (!env.META_VERIFY_TOKEN) return new NextResponse("Verification unavailable", { status: 503 });
  if (mode !== "subscribe" || !constantTimeEqual(token ?? "", env.META_VERIFY_TOKEN) || !challenge) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return new NextResponse(challenge, { status: 200 });
}

export async function POST(request: Request) {
  if (!isFixtureBackend()) return unavailable();
  const env = process.env;
  const tenantId = env.META_EDGE_TENANT_ID;
  const connectionId = env.META_EDGE_CONNECTION_ID;
  if (!tenantId || !connectionId || !OPAQUE_ID.test(tenantId) || !OPAQUE_ID.test(connectionId)) {
    return NextResponse.json({ error: "Edge webhook routing is not configured" }, { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > 2_000_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  if (!env.META_APP_SECRET) {
    return NextResponse.json({ error: "Webhook verification is unavailable" }, { status: 503 });
  }
  const verification = await verifyHmac({
    rawBody: raw,
    secret: env.META_APP_SECRET,
    provided: request.headers.get("x-hub-signature-256") ?? "",
  });
  if (!verification.valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  let body: { entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: unknown }> }> };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const events = body.entry?.flatMap((entry) => entry.changes?.map((change) => ({ entry, change })) ?? []) ?? [];
  await Promise.all(events.map(async ({ entry, change }, index) => acceptProviderEvent({
    tenantId,
    connectionId,
    provider: "META",
    eventId: `${entry.id ?? "entry"}:${index}:${await shortHash(JSON.stringify(change.value ?? {}))}`,
    eventType: change.field ?? "messages",
    payload: JSON.stringify(change.value ?? {}),
  })));
  return NextResponse.json({ accepted: true, count: events.length }, { status: 202 });
}

function unavailable() {
  return NextResponse.json({ error: "Provider ingress is not exposed by the portal" }, { status: 404 });
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

async function shortHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
