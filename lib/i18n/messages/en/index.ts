import { englishAuthMessages } from "./auth.ts";
import { englishAutomationMessages } from "./automation.ts";
import { englishCommonMessages } from "./common.ts";
import { englishCaseMessages } from "./cases.ts";
import { englishInvitationMessages } from "./invitation.ts";
import { englishMarketingMessages } from "./marketing.ts";
import { englishPlatformMessages } from "./platform.ts";
import { englishTenantMessages } from "./tenant.ts";

export const englishMessages = {
  ...englishCommonMessages,
  ...englishAutomationMessages,
  ...englishCaseMessages,
  ...englishAuthMessages,
  ...englishInvitationMessages,
  ...englishMarketingMessages,
  ...englishPlatformMessages,
  ...englishTenantMessages,
} as const;
