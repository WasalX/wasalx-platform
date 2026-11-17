import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../lib/backend";
import { createConnection, getDashboardData } from "../../../lib/data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../lib/request-auth";

export async function GET(request: Request) {
  try {
    await authenticatePortalRequest(request, "connection:read");
    const data = await getDashboardData();
    return NextResponse.json({ data: data.connections });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await authenticatePortalRequest(
      request,
      "connection:write",
    );
    const body = (await request.json()) as {
      provider?: string;
      name?: string;
      engine?: unknown;
      disclosureAccepted?: boolean;
      disclosureVersion?: string;
      accessToken?: string;
      phoneNumberId?: string;
      wabaId?: string;
      eligibilityAccepted?: boolean;
      eligibilityVersion?: string;
    };
    const provider = body.provider?.toUpperCase();
    if (provider !== "WAHA" && provider !== "META") {
      return NextResponse.json(
        { error: "Provider must be WAHA or META" },
        { status: 400 },
      );
    }
    const requestedEngine =
      body.engine === undefined
        ? "GOWS"
        : typeof body.engine === "string"
          ? body.engine.toUpperCase()
          : "";
    let wahaEngine: "GOWS" | undefined;
    if (provider === "WAHA") {
      if (requestedEngine !== "GOWS") {
        return NextResponse.json(
          { error: "Only the qualified GOWS engine is available for new connections" },
          { status: 400 },
        );
      }
      wahaEngine = requestedEngine;
    } else if (body.engine !== undefined) {
      return NextResponse.json(
        { error: "WAHA engine selection is not valid for a Meta connection" },
        { status: 400 },
      );
    }
    if (provider === "WAHA" && !body.disclosureAccepted) {
      return NextResponse.json(
        { error: "The linked-device disclosure must be accepted" },
        { status: 400 },
      );
    }
    if (provider === "META") {
      if (!isControlPlaneBackend()) {
        return NextResponse.json(
          { error: "Official Meta connections require the persistent control plane." },
          { status: 503 },
        );
      }
      if (
        !body.accessToken ||
        !/^\d{5,32}$/u.test(body.phoneNumberId ?? "") ||
        !/^\d{5,32}$/u.test(body.wabaId ?? "")
      ) {
        return NextResponse.json(
          { error: "Meta access token, phone-number ID, and WABA ID are required." },
          { status: 400 },
        );
      }
    }
    const result = await createConnection(
      {
        provider,
        name: body.name?.trim() || `${provider} operations line`,
        engine: wahaEngine,
        disclosureAccepted: body.disclosureAccepted,
        disclosureVersion: body.disclosureVersion,
        accessToken: provider === "META" ? body.accessToken : undefined,
        phoneNumberId: provider === "META" ? body.phoneNumberId : undefined,
        wabaId: provider === "META" ? body.wabaId : undefined,
        eligibilityAccepted: provider === "META" ? body.eligibilityAccepted : undefined,
        eligibilityVersion: provider === "META" ? body.eligibilityVersion : undefined,
      },
      principal.displayName,
      request.headers.get("idempotency-key") ?? undefined,
    );
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
