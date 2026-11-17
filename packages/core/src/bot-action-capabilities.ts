export type BotActionInvocationSurface = "DIRECT_FLOW" | "GROUP_COMMAND";

export type BotActionRetrySemantics =
  | "REPLAY_SAFE"
  | "OUTCOME_UNKNOWN_ON_AMBIGUOUS_FAILURE";

export type BotActionCapabilities = {
  invocation_surfaces: BotActionInvocationSurface[];
  retry_semantics: BotActionRetrySemantics | null;
};

export type BotActionCapabilityInput = {
  kind: unknown;
  endpointUrl: unknown;
  httpMethod: unknown;
  authScheme: unknown;
  secretReference?: unknown;
};

const INVOCATION_SURFACES: BotActionInvocationSurface[] = [
  "DIRECT_FLOW",
  "GROUP_COMMAND",
];

export function botActionCapabilities(
  action: BotActionCapabilityInput,
): BotActionCapabilities {
  if (!isSupportedDeclarativeAction(action)) {
    return { invocation_surfaces: [], retry_semantics: null };
  }
  return {
    invocation_surfaces: [...INVOCATION_SURFACES],
    retry_semantics:
      action.httpMethod === "GET"
        ? "REPLAY_SAFE"
        : "OUTCOME_UNKNOWN_ON_AMBIGUOUS_FAILURE",
  };
}

export function supportsBotActionInvocation(
  action: BotActionCapabilityInput,
  surface: BotActionInvocationSurface,
) {
  return botActionCapabilities(action).invocation_surfaces.includes(surface);
}

function isSupportedDeclarativeAction(action: BotActionCapabilityInput) {
  if (
    (action.httpMethod !== "GET" && action.httpMethod !== "POST") ||
    (action.authScheme !== "NONE" && action.authScheme !== "BEARER") ||
    !hasValidCredentialBinding(action.authScheme, action.secretReference)
  ) {
    return false;
  }

  let endpoint: URL;
  try {
    endpoint = new URL(String(action.endpointUrl ?? ""));
  } catch {
    return false;
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    return false;
  }

  if (action.kind === "HTTP_JSON") return true;
  return action.kind === "NOTION_CREATE_PAGE" &&
    action.httpMethod === "POST" &&
    action.authScheme === "BEARER" &&
    endpoint.origin === "https://api.notion.com" &&
    endpoint.pathname === "/v1/pages";
}

function hasValidCredentialBinding(authScheme: unknown, secretReference: unknown) {
  if (authScheme === "NONE") return secretReference == null;
  return typeof secretReference === "string" &&
    /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(secretReference);
}
