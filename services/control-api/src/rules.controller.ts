import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { Requires } from "./permission.guard.js";
import {
  requireRuleIdempotencyKey,
  requireRuleSetUuid,
  RuleGovernanceService,
  ruleMetricDays,
} from "./rule-governance.service.js";
import type { AuthenticatedRequest } from "./types.js";

@Controller("v1/rule-sets")
export class RulesController {
  constructor(private readonly rules: RuleGovernanceService) {}

  @Get()
  @Requires("rule:read")
  list(@Req() request: AuthenticatedRequest, @Query("before") before?: string, @Query("limit") limit?: string, @Query("state") state?: string) {
    return this.rules.list(request.principal,{before,limit,state});
  }

  @Get(":id")
  @Requires("rule:read")
  detail(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return this.rules.detail(request.principal, requireRuleSetUuid(id));
  }

  @Get(":id/readiness")
  @Requires("rule:read")
  readiness(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return this.rules.readiness(request.principal, requireRuleSetUuid(id));
  }

  @Get(":id/metrics")
  @Requires("rule:read")
  metrics(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("days") days: string | undefined,
  ) {
    return this.rules.metrics(
      request.principal,
      requireRuleSetUuid(id),
      ruleMetricDays(days),
    );
  }

  @Get(":leftId/compare/:rightId")
  @Requires("rule:read")
  compare(
    @Req() request: AuthenticatedRequest,
    @Param("leftId") leftId: string,
    @Param("rightId") rightId: string,
  ) {
    return this.rules.compare(
      request.principal,
      requireRuleSetUuid(leftId, "Left rule-set ID"),
      requireRuleSetUuid(rightId, "Right rule-set ID"),
    );
  }

  @Post()
  @Requires("rule:write")
  create(
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.rules.create(
      request.principal,
      requireRuleIdempotencyKey(idempotencyKey),
      String(request.id),
      body,
    );
  }

  @Post(":id/clone")
  @Requires("rule:write")
  clone(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.rules.clone(
      request.principal,
      requireRuleSetUuid(id),
      requireRuleIdempotencyKey(idempotencyKey),
      String(request.id),
      body,
    );
  }

  @Post(":id/activate")
  @Requires("rule:write")
  activate(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.rules.activate(
      request.principal,
      requireRuleSetUuid(id),
      requireRuleIdempotencyKey(idempotencyKey),
      String(request.id),
      body,
    );
  }

  @Post(":id/rollback")
  @Requires("rule:write")
  rollback(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.rules.rollback(
      request.principal,
      requireRuleSetUuid(id),
      requireRuleIdempotencyKey(idempotencyKey),
      String(request.id),
      body,
    );
  }
}
