import { NextResponse } from "next/server";
import { isControlPlaneBackend } from "../../../lib/backend";
import {
  confirmWahaPasskey,
  getWahaAuthorizationQr,
  getWahaPasskeyChallenge,
  getWahaPasskeyConfirmation,
  requestWahaPairingCode,
  recordWahaScanCompleted,
  submitWahaPasskey,
  type WahaPasskeyAssertion,
} from "../../../lib/control-plane-data";
import {
  authenticatePortalRequest,
  authErrorResponse,
} from "../../../lib/request-auth";

export type WahaAuthorizationAction =
  | "qr"
  | "scan-complete"
  | "pairing-code"
  | "passkey/challenge"
  | "passkey"
  | "passkey/confirmation"
  | "passkey/confirm";

type RouteContext = { params: Promise<{ id: string }> };

export async function wahaAuthorizationRoute(
  request: Request,
  context: RouteContext,
  action: WahaAuthorizationAction,
) {
  try {
    await authenticatePortalRequest(request, "connection:write");
    if (!isControlPlaneBackend()) {
      return noStoreJson(
        {
          error:
            "WhatsApp authorization requires the managed service.",
        },
        501,
      );
    }
    const { id } = await context.params;
    let result: unknown;
    if (action === "qr") result = await getWahaAuthorizationQr(id);
    else if (action === "scan-complete") result = await recordWahaScanCompleted(id);
    else if (action === "passkey/challenge") {
      result = await getWahaPasskeyChallenge(id);
    } else if (action === "passkey/confirmation") {
      result = await getWahaPasskeyConfirmation(id);
    } else {
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey) {
        return noStoreJson(
          { error: "A valid Idempotency-Key header is required." },
          400,
        );
      }
      if (action === "pairing-code") {
        const body = (await request.json().catch(() => ({}))) as {
          phoneNumber?: unknown;
        };
        if (typeof body.phoneNumber !== "string") {
          return noStoreJson(
            { error: "A phone number in international format is required." },
            400,
          );
        }
        result = await requestWahaPairingCode(
          id,
          body.phoneNumber,
          idempotencyKey,
        );
      } else if (action === "passkey") {
        const body = (await request.json().catch(() => ({}))) as {
          assertion?: WahaPasskeyAssertion;
        };
        if (!body.assertion) {
          return noStoreJson(
            { error: "A passkey assertion is required." },
            400,
          );
        }
        result = await submitWahaPasskey(
          id,
          body.assertion,
          idempotencyKey,
        );
      } else {
        result = await confirmWahaPasskey(id, idempotencyKey);
      }
    }
    return noStoreJson(result, 200);
  } catch (error) {
    const response = authErrorResponse(error);
    response.headers.set("Cache-Control", "no-store, private, max-age=0");
    response.headers.set("Pragma", "no-cache");
    return response;
  }
}

function noStoreJson(value: unknown, status: number) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
    },
  });
}
