import type { DictionaryFor } from "../../translate.ts";
import type { englishMessages } from "../en/index.ts";
import { arabicAuthMessages } from "./auth.ts";
import { arabicAutomationMessages } from "./automation.ts";
import { arabicCommonMessages } from "./common.ts";
import { arabicCaseMessages } from "./cases.ts";
import { arabicInvitationMessages } from "./invitation.ts";
import { arabicMarketingMessages } from "./marketing.ts";
import { arabicPlatformMessages } from "./platform.ts";
import { arabicTenantMessages } from "./tenant.ts";

export const arabicMessages = {
  ...arabicCommonMessages,
  ...arabicAutomationMessages,
  ...arabicCaseMessages,
  ...arabicAuthMessages,
  ...arabicInvitationMessages,
  ...arabicMarketingMessages,
  ...arabicPlatformMessages,
  ...arabicTenantMessages,
} as const satisfies DictionaryFor<typeof englishMessages>;
