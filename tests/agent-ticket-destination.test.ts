import assert from "node:assert/strict";
import test from "node:test";
import { agentTicketDestination } from "../lib/agent-ticket-destination.ts";

test("ticket links stay in the WasalX inbox on the authorized request origin", () => {
  assert.equal(agentTicketDestination("https://portal.example/api/cases/case/open?view=mobile", "1042"),
    "https://portal.example/app?view=inbox&ticket=1042");
  for (const number of ["", "0", "../42", "https://other.example", "42&view=admin", "1".repeat(17)])
    assert.throws(() => agentTicketDestination("https://portal.example/api/deliveries/id/open", number));
});
