import { parseWahaTestRecipientAllowlist } from "../../../packages/core/src/waha-test-recipient-scope.js";
parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST);

const { startNodeObservability } = await import("@wasalx/observability/node");
startNodeObservability({ serviceName: "wasalx-connector-worker" });
await import("./main.js");

export {};
