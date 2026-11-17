import {
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Headers,
  Injectable,
  NestInterceptor,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseInterceptors,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { Requires } from "./permission.guard.js";
import type { AuthenticatedRequest } from "./types.js";
import { WahaAuthorizationService } from "./waha-authorization.service.js";

@Injectable()
class NoStoreAuthorizationResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<{
      header(name: string, value: string): unknown;
    }>();
    response.header("Cache-Control", "no-store, private, max-age=0");
    response.header("Pragma", "no-cache");
    return next.handle();
  }
}

@Controller("v1/connections/:id/auth")
@UseInterceptors(NoStoreAuthorizationResponseInterceptor)
@Requires("connection:write")
export class WahaAuthorizationController {
  constructor(private readonly authorization: WahaAuthorizationService) {}

  @Get("qr")
  qr(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ) {
    return this.authorization.qr(request, id);
  }

  @Post("scan-complete")
  scanComplete(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ) {
    return this.authorization.scanComplete(request, id);
  }

  @Post("pairing-code")
  pairingCode(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: { phoneNumber?: unknown },
  ) {
    return this.authorization.pairingCode(request, id, idempotencyKey, body.phoneNumber);
  }

  @Get("passkey/challenge")
  passkeyChallenge(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ) {
    return this.authorization.passkeyChallenge(request, id);
  }

  @Post("passkey")
  submitPasskey(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: { assertion?: unknown },
  ) {
    return this.authorization.submitPasskey(request, id, idempotencyKey, body.assertion);
  }

  @Get("passkey/confirmation")
  passkeyConfirmation(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ) {
    return this.authorization.passkeyConfirmation(request, id);
  }

  @Post("passkey/confirm")
  confirmPasskey(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.authorization.confirmPasskey(request, id, idempotencyKey);
  }
}
