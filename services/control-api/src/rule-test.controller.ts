import { Body, Controller, Post } from "@nestjs/common";
import { Requires } from "./permission.guard.js";
import { RuleTestService, type RuleTestRequest } from "./rule-test.service.js";

@Controller("v1/rules")
export class RuleTestController {
  constructor(private readonly tester: RuleTestService) {}

  @Post("test")
  @Requires("rule:read")
  test(@Body() body: RuleTestRequest) {
    return this.tester.evaluate(body);
  }
}
