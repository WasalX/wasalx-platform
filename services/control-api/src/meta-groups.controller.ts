import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { MetaGroupsService } from "./meta-groups.service.js";
import { Requires } from "./permission.guard.js";
import type { AuthenticatedRequest } from "./types.js";

@Controller("v1/connections/:connectionId/meta")
export class MetaGroupsController {
  constructor(private readonly groups: MetaGroupsService) {}

  @Get("capabilities")
  @Requires("connection:read")
  capability(
    @Req() request: AuthenticatedRequest,
    @Param("connectionId") connectionId: string,
  ) {
    return this.groups.capability(request, connectionId);
  }

  @Post("groups")
  @HttpCode(HttpStatus.ACCEPTED)
  @Requires("group:write")
  create(
    @Req() request: AuthenticatedRequest,
    @Param("connectionId") connectionId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body()
    body: {
      subject: string;
      description?: string;
      joinApprovalMode?: "approval_required" | "auto_approve";
    },
  ) {
    return this.groups.createGroup(request, connectionId, idempotencyKey, body);
  }

  @Get("groups/:groupId/invite-link")
  @Requires("group:read")
  inviteLink(
    @Req() request: AuthenticatedRequest,
    @Param("connectionId") connectionId: string,
    @Param("groupId") groupId: string,
  ) {
    return this.groups.getInviteLink(request, connectionId, groupId);
  }

  @Post("groups/:groupId/invite-link/reset")
  @Requires("group:write")
  resetInviteLink(
    @Req() request: AuthenticatedRequest,
    @Param("connectionId") connectionId: string,
    @Param("groupId") groupId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.groups.resetInviteLink(request, connectionId, groupId, idempotencyKey);
  }

  @Put("groups/:groupId")
  @Requires("group:write")
  update(
    @Req() request: AuthenticatedRequest,
    @Param("connectionId") connectionId: string,
    @Param("groupId") groupId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: { subject?: string; description?: string },
  ) {
    return this.groups.updateGroup(request, connectionId, groupId, idempotencyKey, body);
  }
}
