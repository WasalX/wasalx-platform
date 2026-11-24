import { WORKSPACE_INLINE_MEDIA_TYPES } from "../packages/core/src/media";
import {metaTariffQueryString,type MetaTariffQuery,type MetaTariffPage,type MetaPolicySelection} from '../packages/core/src/meta-billing-policy-contract';
import { cookies } from "next/headers";
import type { NativeRoutingSyncCommand, NativeRoutingSyncStatus } from "../packages/core/src/native-routing-contract";
export async function getNativeRoutingSync(){return call<NativeRoutingSyncStatus>(await currentPortalSession(),"/v1/zammad/routing-sync");}
export async function requestNativeRoutingSync(command:NativeRoutingSyncCommand,key:string){return call<NativeRoutingSyncStatus>(await currentPortalSession(),"/v1/zammad/routing-sync",{method:"POST",headers:{"idempotency-key":key},body:JSON.stringify(command)});}
import { traceCarrierHeaders, withSpan } from "@wasalx/observability";
import { readBoundedBody, readBoundedJson } from "./bounded-json.ts";
import {
  BOT_CONVERSATION_PAGE_SIZE,
  type BotConversationEventPage,
  type BotConversationPage,
  type BotConversationPageQuery,
} from "./bot-conversations";
import type { TriggerRule } from "./domain";
import type { RuleTestRequest, RuleTestResult } from "./rule-test-contract";
import {
  PortalSessionError,
  sessionCookieName,
  type PortalSession,
} from "./portal-session";

export type {MetaAddAccessActivationView} from "../packages/core/src/meta-add-access-activation-contract";
export async function getMetaSavedAccessActivation(id:string){return call<import("../packages/core/src/meta-add-access-activation-contract").MetaAddAccessActivationView>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/activation`);}
export async function requestMetaSavedAccessActivation(id:string,key:string,body:import("../packages/core/src/meta-add-access-activation-contract").MetaAddAccessActivationRequest,origin:string){
  return call<ConnectionOperationAccepted>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/activation`,{method:'POST',headers:{'idempotency-key':key,origin},body:JSON.stringify(body)});
}
export async function getMetaNumberRelease(id:string){
  return call<Record<string,unknown>>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/number-release`);
}
export async function requestMetaNumberRelease(id:string,key:string,body:unknown,origin:string){
  return call<Record<string,unknown>>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/number-release`,
    {method:"POST",headers:{"idempotency-key":key,origin},body:JSON.stringify(body)});
}
type Row = Record<string, unknown>;
export type ConnectionLifecycleAction =
  | "start"
  | "restart"
  | "pause"
  | "disconnect"
  | "groups/sync";

export type ConnectionOperation = {
  id: string;
  type: string;
  state: string;
  attempts: number;
  created_at: string;
};

export type ConnectionOperationAccepted = {
  id: string;
  state: string;
  operation: ConnectionOperation;
  duplicate: boolean;
};

export type MetaBillingDiagnosticView = {
  operationId: string | null;
  state: string | null;
  current: boolean;
  diagnostic: Omit<import("../packages/core/src/meta-billing-diagnostic").MetaBillingDiagnostic, "responseSha256"> | null;
};
export type MetaCustomerPolicyView={tariffOffers?:MetaTariffPage|null;enrolled:boolean;mode:'CUSTOMER'|'MANAGED'|null;revision:number;sendReady:boolean;
  paymentMethod:'PRESENT'|'NONE'|'UNAVAILABLE';checkedAt:string|null;actualPayer:'UNVERIFIED'|'APPROVED_SOLUTION_PARTNER';customerOwnership:'UNVERIFIED';managedAvailable:boolean;managedChoices?:Array<{choiceId:string;kind:'OWN_SOLUTION_PARTNER_LINE'|'MULTI_PARTNER_SOLUTION';evidenceMode:'LIVE'|'SIMULATED';expiresAt:string;documentSha256:string;documentText:string}>;state?:string|null};
export type {MetaTransitionPreviewView,MetaTransitionPreviewPage} from '../packages/core/src/meta-account-transition-contract';
export async function getMetaTransitionPage(id:string){return call<import('../packages/core/src/meta-account-transition-contract').MetaTransitionPreviewPage>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/account-transitions`);}
export async function getMetaTransitionPreview(id:string,planId:string){return call<import('../packages/core/src/meta-account-transition-contract').MetaTransitionPreviewView>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/account-transitions/${encodeURIComponent(planId)}`);}
export async function requestMetaTransitionPreview(id:string,path:string[],body:unknown,key:string|null){
  return call<{id:string;duplicate:boolean}>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/account-transitions${path.length?'/'+path.map(encodeURIComponent).join('/'):''}`,
    {method:'POST',headers:key?{'idempotency-key':key}:{},body:JSON.stringify(body)});
}

export async function getMetaCustomerPolicy(id:string,query:MetaTariffQuery|null=null){return call<MetaCustomerPolicyView>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/billing-policy${metaTariffQueryString(query)}`);}
export async function requestMetaCustomerPolicy(id:string,key:string,body:MetaPolicySelection){
  return call<ConnectionOperationAccepted>(await currentPortalSession(),`/v1/connections/${encodeURIComponent(id)}/meta/billing-policy`,{method:'POST',headers:{'idempotency-key':key},body:JSON.stringify(body)});
}

export async function getMetaBillingDiagnostic(id: string) {
  return call<MetaBillingDiagnosticView>(await currentPortalSession(), `/v1/connections/${encodeURIComponent(id)}/meta/billing-diagnostic`);
}

export async function requestMetaBillingDiagnostic(id: string, idempotencyKey: string) {
  return call<ConnectionOperationAccepted>(await currentPortalSession(), `/v1/connections/${encodeURIComponent(id)}/meta/billing-diagnostic`,
    {method:"POST",headers:{"idempotency-key":idempotencyKey},body:"{}"});
}

export type WahaQrAuthorization = {
  imageDataUrl: string | null;
  providerState: string;
  issuedAt: string | null;
  expiresAt: string | null;
  sequence: number;
  expired: boolean;
};

export type WahaPasskeyChallenge = {
  challenge: string;
  timeout?: number;
  rpId: "web.whatsapp.com";
  allowCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: Array<"ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">;
  }>;
  userVerification?: "discouraged" | "preferred" | "required";
};

export type WahaPasskeyAssertion = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
};

export type MetaGroupsCapability = {
  eligible: false;
  state: "CONSENT_REQUIRED";
  checkedAt: string;
  evidence: "local_policy";
} | {
  eligible: boolean;
  state:
    | "AVAILABLE"
    | "CREDENTIAL_INVALID"
    | "PERMISSION_REQUIRED"
    | "NOT_ELIGIBLE"
    | "TEMPORARILY_UNAVAILABLE";
  reasonCode?: string;
  checkedAt: string;
  evidence: "provider_probe";
  constraints: {
    officialBusinessAccountRequired: true;
    inviteOnly: true;
    maxParticipants: 8;
    maxGroupsPerNumber: 10_000;
    unavailableForBusinessAppNumbers: true;
    unavailableForMultiSolutionConversations: true;
  };
  documentationUrl: string;
};

export type ConnectionDetail = Row & {
  id: string;
  name: string;
  provider: string;
  state: string;
  phone: string;
  group_count: number;
  last_event_at: unknown;
};
export type WorkspaceSettings = Row & {
  id: string;
  name: string;
  slug: string;
  accent_color: string;
  default_theme: "LIGHT" | "DARK" | "SYSTEM";
  version: number;
};
export type NativeAccountObservation = {
  state: "VERIFIED" | "DRIFT" | "UNAVAILABLE" | "UNVERIFIED";
  checkedAt: string | null;
  revision: number;
  nativeUserId: string | null;
};
export type TeamAccessData = {
  members: Array<Row & { nativeObservation?: NativeAccountObservation }>;
  invitations: Row[];
  capabilities: {
    can_invite: boolean;
    can_manage_members: boolean;
    can_manage_owners: boolean;
  };
};
export type CaseCorrelation = Row & {
  id: string;
  normalized_reference: string;
  zammad_ticket_id: string;
  zammad_ticket_number: string;
  state: "OPEN" | "RESOLVED" | "DETACHED";
  generation: number;
  version: number;
  group_name: string;
  zammad_agent_available: boolean;
};
export class ControlPlaneError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly workspaceProof?: { group_id?: string; effect?: "NONE"; terminal?: true },
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export async function currentPortalSession() {
  const value = (await cookies()).get(sessionCookieName())?.value;
  if (!value) throw new PortalSessionError("Sign in is required");
  const { loadStoredPortalSession } = await import("./portal-session-store.ts");
  return loadStoredPortalSession(value);
}

export async function getDashboardData() {
  const session = await currentPortalSession();
  const auditAllowed =
    session.role === "tenant_owner" ||
    session.role === "tenant_admin" ||
    session.role === "supervisor" ||
    session.role === "auditor";
  const settingsAllowed = session.role !== "agent";
  const [connections, groups, ruleSets, deliveries, audit, health, workspace] = await Promise.all([
    callList<Row>(session, "/v1/connections"),
    call<Row[]>(session, "/v1/groups?limit=200"),
    call<Row[]>(session, "/v1/rule-sets?state=ACTIVE&limit=200"),
    call<Row[]>(session, "/v1/deliveries"),
    auditAllowed
      ? call<Row[]>(session, "/v1/audit-events?routine=exclude")
      : Promise.resolve([]),
    call<Row>(session, "/v1/health"),
    settingsAllowed
      ? call<Row>(session, "/v1/settings/workspace")
      : Promise.resolve(null),
  ]);
  const rules: TriggerRule[] = ruleSets.filter((set) => set.state === "ACTIVE").flatMap((set) =>
    ((set.rules as Row[] | null) ?? []).map((rule) => ({
      id: String(rule.id),
      name: String(rule.name),
      matcherType: (rule.matcherType ?? rule.matcher_type) as TriggerRule["matcherType"],
      pattern: String(rule.pattern),
      prefix:
        typeof ((rule.matcherOptions ?? rule.matcher_options) as Row | undefined)?.prefix === "string"
          ? String(((rule.matcherOptions ?? rule.matcher_options) as Row).prefix)
          : null,
      digitLength:
        Number(((rule.matcherOptions ?? rule.matcher_options) as Row | undefined)?.digitLength ?? 0) ||
        null,
      groupCommand: ((rule.matcherOptions ?? rule.matcher_options) as Row | undefined)?.groupCommand as TriggerRule["groupCommand"] | undefined,
      teamSenderPolicy: ((rule.matcherOptions ?? rule.matcher_options) as Row | undefined)?.teamSenderPolicy as TriggerRule["teamSenderPolicy"],
      priority: Number(rule.priority),
      enabled: Boolean(rule.enabled),
      matchCount: Number(rule.match_count ?? set.matched_reference_count ?? 0),
      version: Number(set.version),
    })),
  );
  return {
    tenant: {
      id: session.tenantId,
      name: session.tenantName,
      slug: session.tenantSlug,
      plan: "Managed",
      accent: "#5B5BD6",
      role: session.role,
      runtime: "CONTROL_PLANE",
      default_theme: workspace?.default_theme ?? "SYSTEM",
    },
    connections: connections.map(normalizeConnection),
    groups: groups.map(normalizeGroup),
    rules,
    deliveries: deliveries.map((row) => {
      const publicRow = { ...row };
      delete publicRow.zammad_ticket_id;
      return {
        ...publicRow,
        ticket_number: friendlyTicketNumber(row.ticket_number),
        excerpt: "Message content redacted",
        body_available: row.body_available === true,
        error_message: row.safe_error,
      };
    }),
    audit: normalizeAuditRows(audit),
    health,
  };
}

function normalizeGroup(row:Row){return{
  ...row,name:row.display_name,zammad_group:row.zammad_group_id??"Not configured",
  rule_name:row.rule_set_name??"Not configured",enabled:row.binding_state==="ACTIVE",
  members:row.participant_count===null?null:Number(row.participant_count??0),last_message_at:row.last_synced_at,
}}

export async function getGroups(input:{after?:string;limit?:number;query?:string;connectionId?:string}={}){
  const query=new URLSearchParams();if(input.after)query.set("after",input.after);if(input.limit!==undefined)query.set("limit",String(input.limit));if(input.query)query.set("q",input.query);if(input.connectionId)query.set("connection",input.connectionId);
  return(await call<Row[]>(await currentPortalSession(),`/v1/groups${query.size?`?${query}`:""}`)).map(normalizeGroup);
}

function friendlyTicketNumber(value: unknown) {
  if (typeof value !== "string") return null;
  const number = value.trim().replace(/^#+/u, "");
  if (!number || [...number].length > 64 || /[\p{Cc}\p{Cf}\s]/u.test(number)) return null;
  return `#${number}`;
}

export async function getAuditEvents(cursor?: { createdAt: string; id: string }, routine: "include" | "exclude" = "exclude") {
  const query = new URLSearchParams({ routine });
  if(cursor){query.set("cursor",cursor.createdAt);query.set("cursorId",cursor.id)}
  return normalizeAuditRows(
    await call<Row[]>(await currentPortalSession(), `/v1/audit-events?${query}`),
  );
}

function normalizeAuditRows(rows: Row[]) {
  return rows.map((row) => ({
    ...row,
    actor: row.actor_display_name ?? row.actor_id,
    detail: row.action,
    target: row.target_id,
  }));
}

export async function restartConnection(id: string, actor: string, idempotencyKey?:string) {
  void actor;
  return connectionLifecycle(id, "restart", idempotencyKey);
}

export async function getConnectionDetail(id: string) {
  const row = await call<Row>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}`,
  );
  return normalizeConnection(row) as ConnectionDetail;
}

export async function connectionLifecycle(
  id: string,
  action: ConnectionLifecycleAction,
  idempotencyKey?: string,
  body?: Record<string, unknown>,
) {
  return call<ConnectionOperationAccepted>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      headers: idempotencyKey
        ? { "idempotency-key": idempotencyKey }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
}

export async function getWahaAuthorizationQr(id: string) {
  return call<WahaQrAuthorization>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/auth/qr`,
  );
}

export async function recordWahaScanCompleted(id: string) {
  return call<{ recordedAt: string }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/auth/scan-complete`,
    { method: "POST", body: "{}" },
  );
}

export async function requestWahaPairingCode(
  id: string,
  phoneNumber: string,
  idempotencyKey: string,
) {
  return call<{ code: string; expiresAt?: string }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/auth/pairing-code`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ phoneNumber }),
    },
  );
}

export async function getWahaPasskeyChallenge(id: string) {
  return call<WahaPasskeyChallenge>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/auth/passkey/challenge`,
  );
}

export async function submitWahaPasskey(
  id: string,
  assertion: WahaPasskeyAssertion,
  idempotencyKey: string,
) {
  return call<{ accepted: true; duplicate?: true }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/auth/passkey`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ assertion }),
    },
  );
}

export async function getWahaPasskeyConfirmation(id: string) {
  return call<{ code: string }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/auth/passkey/confirmation`,
  );
}

export async function confirmWahaPasskey(id: string, idempotencyKey: string) {
  return call<{ confirmed: true; duplicate?: true }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/auth/passkey/confirm`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
    },
  );
}
export async function toggleGroup(id: string, enabled: boolean, actor: string, expectedRevision:number, idempotencyKey:string) {
  void actor;
  return call(
    await currentPortalSession(),
    `/v1/groups/${encodeURIComponent(id)}/toggle`,
    { method: "POST", headers:{"idempotency-key":idempotencyKey},body: JSON.stringify({ enabled,expectedRevision }) },
  );
}
export async function getGroupDetail(id: string) {
  const session = await currentPortalSession();
  const [group, ruleSets] = await Promise.all([
    call<Row>(session, `/v1/groups/${encodeURIComponent(id)}`),
    call<Row[]>(session, "/v1/rule-sets"),
  ]);
  return {
    ...group,
    available_rule_sets: ruleSets.map((ruleSet) => ({
      id: ruleSet.id,
      name: ruleSet.name,
      version: ruleSet.version,
      state: ruleSet.state,
      enabled_rule_count: ((ruleSet.rules as Row[] | null) ?? []).filter(
        (rule) => Boolean(rule.enabled),
      ).length,
    })),
  };
}
export async function saveGroupBinding(id: string, input: Record<string, unknown>,idempotencyKey:string) {
  return call<{ id: string; state: string }>(
    await currentPortalSession(),
    `/v1/groups/${encodeURIComponent(id)}/binding`,
    { method: "PUT",headers:{"idempotency-key":idempotencyKey}, body: JSON.stringify(input) },
  );
}
export async function getGroupWorkspaceSettings() {
  return call<Row>(await currentPortalSession(), "/v1/group-workspace/settings");
}
export async function updateGroupWorkspaceSettings(input: Record<string, unknown>,idempotencyKey:string) {
  return call<Row>(await currentPortalSession(), "/v1/group-workspace/settings", { method: "PUT", headers:{"idempotency-key":idempotencyKey},body: JSON.stringify(input) });
}
export async function getWahaOutboundSafety() {
  return call<Row>(await currentPortalSession(), "/v1/settings/waha-outbound-safety");
}
export async function updateWahaOutboundConnectionSafety(connectionId:string,input:Record<string,unknown>,idempotencyKey:string) {
  return call<Row>(await currentPortalSession(), `/v1/settings/waha-outbound-safety/connections/${encodeURIComponent(connectionId)}`, { method:"PATCH",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input) });
}
export async function getGroupWorkspaceGroup(id: string) {
  return call<Row>(await currentPortalSession(), `/v1/group-workspace/groups/${encodeURIComponent(id)}`);
}
export async function updateGroupWorkspaceGroup(id: string, input: Record<string, unknown>,idempotencyKey:string) {
  return call<Row>(await currentPortalSession(), `/v1/group-workspace/groups/${encodeURIComponent(id)}`, { method: "PUT",headers:{"idempotency-key":idempotencyKey}, body: JSON.stringify(input) });
}
export async function grantGroupWorkspaceAccess(id: string, input: Record<string, unknown>,idempotencyKey:string) {
  return call<Row>(await currentPortalSession(), `/v1/group-workspace/groups/${encodeURIComponent(id)}/grants`, { method: "POST",headers:{"idempotency-key":idempotencyKey}, body: JSON.stringify(input) });
}
export async function revokeGroupWorkspaceAccess(id: string, grantId: string,idempotencyKey:string) {
  return call<Row>(await currentPortalSession(), `/v1/group-workspace/groups/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, { method: "DELETE",headers:{"idempotency-key":idempotencyKey} });
}
export async function getZammadRoutingCatalog() {
  return call<Row>(await currentPortalSession(), "/v1/zammad/routing-catalogs");
}
export async function stopRetryingDelivery(id:string,body:unknown,idempotencyKey:string) {
  return call(await currentPortalSession(),`/v1/deliveries/${encodeURIComponent(id)}/stop-retrying`,
    {method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(body)});
}

export async function retryDelivery(id: string, actor: string, confirmOutcomeUnknown = false,idempotencyKey:string) {
  void actor;
  return call(
    await currentPortalSession(),
    `/v1/deliveries/${encodeURIComponent(id)}/retry`,
    { method: "POST",headers:{"idempotency-key":idempotencyKey}, body: JSON.stringify({ confirmOutcomeUnknown }) },
  );
}
export async function getDeliveryDetail(id:string){return call<Row>(await currentPortalSession(),`/v1/deliveries/${encodeURIComponent(id)}`)}
export async function getDeliveryAgentDestination(id:string){return call<{ticket_number:string}>(await currentPortalSession(),`/v1/deliveries/${encodeURIComponent(id)}/workspace-ticket`)}
export async function revealDeliveryContent(id:string){return call<{body:string;revealed_at:string;expires_in_seconds:number}>(await currentPortalSession(),`/v1/deliveries/${encodeURIComponent(id)}/content`,{method:"POST",body:JSON.stringify({purpose:"OPERATIONAL_REVIEW",confirmation:"REVEAL"})})}
export async function getCases(input:{before?:string;limit?:number;ticket?:string}={}){const query=new URLSearchParams();if(input.before)query.set("before",input.before);if(input.limit!==undefined)query.set("limit",String(input.limit));if(input.ticket)query.set("ticket",input.ticket);return call<CaseCorrelation[]>(await currentPortalSession(),`/v1/cases${query.size?`?${query}`:""}`)}
export async function getCaseAgentDestination(id:string){return call<{ticket_number:string}>(await currentPortalSession(),`/v1/cases/${encodeURIComponent(id)}/workspace-ticket`)}
export async function detachCase(id:string,expectedVersion:number,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/cases/${encodeURIComponent(id)}/detach`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify({expectedVersion,confirmation:"START_NEW_CASE"})})}
export async function getReviewItems(state?:string){const query=state?`?state=${encodeURIComponent(state)}`:"";return call<Row[]>(await currentPortalSession(),`/v1/reviews${query}`)}
export async function getReviewItem(id:string){return call<Row>(await currentPortalSession(),`/v1/reviews/${encodeURIComponent(id)}`)}
export async function reviewAction(id:string,action:"resolve"|"discard"|"reprocess",input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/reviews/${encodeURIComponent(id)}/${action}`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function createRule(
  input: Omit<TriggerRule, "id" | "matchCount" | "version"> & {
    savedExamples?: Array<{ name: string; message: string; expectedMatches: string[]; sender?: "team" | "customer" | "unknown" }>;
  },
  actor: string,
  idempotencyKey: string,
) {
  void actor;
  const session = await currentPortalSession();
  const result = await call<{ id: string }>(session, "/v1/rule-sets", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      name: input.name,
      rules: [
        {
          name: input.name,
          matcherType: input.matcherType,
          pattern: input.pattern,
          priority: input.priority,
          enabled: input.enabled,
          matcherOptions:{...(
            input.matcherType === "prefix_length"
              ? { prefix: input.prefix, digitLength: input.digitLength }
              : input.matcherType === "exact_length"
                ? { digitLength: input.digitLength }
                : {}),...(input.groupCommand?{groupCommand:input.groupCommand}:{}),...(input.teamSenderPolicy?{teamSenderPolicy:input.teamSenderPolicy}:{})},
          savedExamples: input.savedExamples ?? [],
        },
      ],
    }),
  });
  return result.id;
}

export async function testRulesAtControlPlane(input: RuleTestRequest) {
  return call<RuleTestResult>(await currentPortalSession(), "/v1/rules/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getRuleSetVersions(input:{before?:string;limit?:number;state?:string}={}) {
  const query=new URLSearchParams();if(input.before)query.set("before",input.before);if(input.limit!==undefined)query.set("limit",String(input.limit));if(input.state)query.set("state",input.state);
  return call<Row[]>(await currentPortalSession(), `/v1/rule-sets${query.size?`?${query}`:""}`);
}

export async function getTicketEventConfiguration(){return call<{bindings:Row[];groups:Row[];members:Row[]}>(await currentPortalSession(),"/v1/bot-flows/ticket-events")}
export async function bindTicketEvent(input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),"/v1/bot-flows/ticket-events",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function getBotFlows(){return call<Row[]>(await currentPortalSession(),"/v1/bot-flows")}
export async function getBotFlowCatalog(query=""){return call<{items:Row[];next_cursor:string|null}>(await currentPortalSession(),`/v1/bot-flows/catalog${query}`)}
export async function getBotFlow(id:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/${encodeURIComponent(id)}`)}
export async function getBotMediaAssets(ids:string[]=[]){const query=new URLSearchParams();for(const id of ids)query.append("id",id);return call<Row[]>(await currentPortalSession(),`/v1/bot-flows/media-assets${query.size?`?${query}`:""}`)}
export async function createBotMediaAsset(input:{filename:string;mimeType:string;byteSize:number;contentSha256:string},idempotencyKey:string){return call<{id:string;state:string;tenantId:string;uploadToken?:string}>(await currentPortalSession(),"/v1/bot-flows/media-assets",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function getBotActions(){return call<Row[]>(await currentPortalSession(),"/v1/bot-flows/actions")}
export async function getBotActionCatalog(query=""){return call<{items:Row[];next_cursor:string|null}>(await currentPortalSession(),`/v1/bot-flows/actions/catalog${query}`)}
export async function getBotAction(actionKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/actions/${encodeURIComponent(actionKey)}`)}
export async function getBotAssignments(){return call<Row[]>(await currentPortalSession(),"/v1/bot-flows/assignments")}
export async function getBotConversations(input:BotConversationPageQuery={}){
  const query=new URLSearchParams();
  if(input.cursor!==undefined)query.set("cursor",input.cursor);
  query.set("limit",String(input.limit??BOT_CONVERSATION_PAGE_SIZE));
  return call<BotConversationPage>(await currentPortalSession(),`/v1/bot-flows/conversations?${query}`);
}
export async function getBotConversationEvents(conversationId:string,input:BotConversationPageQuery={}){
  const query=new URLSearchParams();
  if(input.cursor!==undefined)query.set("cursor",input.cursor);
  query.set("limit",String(input.limit??BOT_CONVERSATION_PAGE_SIZE));
  return call<BotConversationEventPage>(await currentPortalSession(),`/v1/bot-flows/conversations/${encodeURIComponent(conversationId)}/events?${query}`);
}
export async function saveBotAction(input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),"/v1/bot-flows/actions",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function getBotActionRevisions(actionKey:string){return call<Row[]>(await currentPortalSession(),`/v1/bot-flows/actions/${encodeURIComponent(actionKey)}/revisions`)}
export async function restoreBotActionRevision(actionKey:string,revision:number,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/actions/${encodeURIComponent(actionKey)}/revisions/${revision}/restore`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function storeBotActionCredential(input:Record<string,unknown>,idempotencyKey:string){return call<{secretReference:string}>(await currentPortalSession(),"/v1/bot-flows/actions/credential",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function qualifyBotAction(actionKey:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/actions/${encodeURIComponent(actionKey)}/qualifications`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function getBotActionQualification(actionKey:string,id:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/actions/${encodeURIComponent(actionKey)}/qualifications/${encodeURIComponent(id)}`)}
export async function createBotFlow(input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),"/v1/bot-flows",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function cloneBotFlow(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/${encodeURIComponent(id)}/clone`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function activateBotFlow(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/${encodeURIComponent(id)}/activate`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function assignBotFlow(input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),"/v1/bot-flows/assignments",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function setBotAssignmentState(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/assignments/${encodeURIComponent(id)}/state`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function setBotAssignmentAttribution(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/assignments/${encodeURIComponent(id)}/attribution`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function commandBotConversation(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/conversations/${encodeURIComponent(id)}/command`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function getClientRouting(){return call<Row[]>(await currentPortalSession(),"/v1/bot-flows/routing")}
export async function getClientRoutingCatalog(query=""){return call<{items:Row[];next_cursor:string|null}>(await currentPortalSession(),`/v1/bot-flows/routing/catalog${query}`)}
export async function getClientRoutingVersion(id:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/routing/${encodeURIComponent(id)}`)}
export async function getClientRoutingCapabilities(){return call<{externalConnectorsEnabled:boolean;notionOAuthEnabled:boolean}>(await currentPortalSession(),"/v1/bot-flows/routing/capabilities")}
export async function getClientRoutingSources(){return call<Row[]>(await currentPortalSession(),"/v1/bot-flows/routing/sources")}
export async function getClientRoutingIntegrations(){return call<Row[]>(await currentPortalSession(),"/v1/bot-flows/routing/integrations")}
export async function storeClientRoutingCredential(input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),"/v1/bot-flows/routing/integrations/credential",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function testClientRoutingCredential(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/routing/integrations/${encodeURIComponent(id)}/test`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function getClientRoutingQualifications(versionId:string){return call<Row[]>(await currentPortalSession(),`/v1/bot-flows/routing/${encodeURIComponent(versionId)}/qualifications`)}
export async function qualifyClientRoutingSource(versionId:string,sourceId:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/routing/${encodeURIComponent(versionId)}/sources/${encodeURIComponent(sourceId)}/qualify`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function startNotionRoutingOAuth(integrationId?:string){return call<{authorizationUrl:string;integrationId:string}>(await currentPortalSession(),"/v1/bot-flows/routing/integrations/notion/start",{method:"POST",body:JSON.stringify({integrationId})})}
export async function completeNotionRoutingOAuth(input:Record<string,unknown>){return call<Row>(await currentPortalSession(),"/v1/bot-flows/routing/integrations/notion/callback",{method:"POST",body:JSON.stringify(input)})}
export async function abortNotionRoutingOAuth(input:Record<string,unknown>){return call<Row>(await currentPortalSession(),"/v1/bot-flows/routing/integrations/notion/abort",{method:"POST",body:JSON.stringify(input)})}
export async function syncClientRoutingSource(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/routing/sources/${encodeURIComponent(id)}/sync`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function createClientRouting(input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),"/v1/bot-flows/routing",{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function activateClientRouting(id:string,input:Record<string,unknown>,idempotencyKey:string){return call<Row>(await currentPortalSession(),`/v1/bot-flows/routing/${encodeURIComponent(id)}/activate`,{method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input)})}
export async function simulateClientRouting(input:Record<string,unknown>){return call<Row>(await currentPortalSession(),"/v1/bot-flows/routing/simulate",{method:"POST",body:JSON.stringify(input)})}

export async function getRuleSetReadiness(id: string) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/rule-sets/${encodeURIComponent(id)}/readiness`,
  );
}

export async function compareRuleSetVersions(leftId: string, rightId: string) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/rule-sets/${encodeURIComponent(leftId)}/compare/${encodeURIComponent(rightId)}`,
  );
}

export async function activateRuleSetVersion(
  id: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/rule-sets/${encodeURIComponent(id)}/activate`,
    { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) },
  );
}

export async function cloneRuleSetVersion(id:string,idempotencyKey:string,input:Record<string,unknown>={}){
  return call<Row>(await currentPortalSession(),`/v1/rule-sets/${encodeURIComponent(id)}/clone`,{
    method:"POST",headers:{"idempotency-key":idempotencyKey},body:JSON.stringify(input),
  });
}

export async function rollbackRuleSetVersion(
  id: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/rule-sets/${encodeURIComponent(id)}/rollback`,
    { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) },
  );
}
export async function createConnection(
  input: {
    provider: "WAHA" | "META";
    name: string;
    engine?: "GOWS" | "NOWEB";
    disclosureAccepted?: boolean;
    disclosureVersion?: string;
    accessToken?: string;
    phoneNumberId?: string;
    wabaId?: string;
    eligibilityAccepted?: boolean;
    eligibilityVersion?: string;
  },
  actor: string,
  idempotencyKey?:string,
) {
  void actor;
  return call<ConnectionOperationAccepted>(await currentPortalSession(), "/v1/connections", {
    method: "POST",
    headers:idempotencyKey?{"idempotency-key":idempotencyKey}:undefined,
    body: JSON.stringify(input),
  });
}

export async function getMetaGroupsCapability(id: string) {
  return call<MetaGroupsCapability>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/meta/capabilities`,
  );
}

export async function metaRoutingPortalRequest(id: string, method: "GET" | "POST", body?: unknown, origin?: string, key?: string) {
  return call<unknown>(await currentPortalSession(), `/v1/connections/${encodeURIComponent(id)}/meta/routing`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...(origin ? { origin } : {}), ...(key ? { "idempotency-key": key } : {}) },
  });
}

export async function metaThreadControlPortalRequest(id: string, method: "GET" | "POST", body?: unknown, origin?: string, key?: string) {
  return call<unknown>(await currentPortalSession(), `/v1/bot-flows/conversations/${encodeURIComponent(id)}/meta-thread-control`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...(origin ? { origin } : {}), ...(key ? { "idempotency-key": key } : {}) },
  });
}

export async function metaCoexistencePortalRequest(id: string, suffix: string, method: "GET" | "POST", body?: unknown, origin?: string) {
  return call<unknown>(await currentPortalSession(), `/v1/connections/${encodeURIComponent(id)}/meta/coexistence${suffix}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(origin ? { headers: { origin } } : {}),
  });
}

export async function metaSignupPortalRequest(path: string, method: "GET" | "POST", body?: unknown, origin?: string) {
  return call<unknown>(await currentPortalSession(), `/v1/connections/meta/signup/${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(origin ? { headers: { origin } } : {}),
  });
}

export async function rotateMetaCredential(id: string, accessToken: string, idempotencyKey: string) {
  return call<{ rotated: true; duplicate?: boolean }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/meta/credentials`,
    { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify({ accessToken }) },
  );
}

export async function createMetaOfficialGroup(
  id: string,
  input: {
    subject: string;
    description?: string;
    joinApprovalMode?: "approval_required" | "auto_approve";
  },
  idempotencyKey: string,
) {
  return call<{ requestId: string; actionId: string; duplicate: boolean }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(id)}/meta/groups`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    },
  );
}

export async function getMetaGroupInviteLink(connectionId: string, groupId: string) {
  return call<{ inviteLink: string }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(connectionId)}/meta/groups/${encodeURIComponent(groupId)}/invite-link`,
  );
}

export async function resetMetaGroupInviteLink(
  connectionId: string,
  groupId: string,
  idempotencyKey: string,
) {
  return call<{ inviteLink: string; actionId: string; duplicate: boolean }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(connectionId)}/meta/groups/${encodeURIComponent(groupId)}/invite-link/reset`,
    { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: "{}" },
  );
}

export async function updateMetaOfficialGroup(
  connectionId: string,
  groupId: string,
  input: { subject?: string; description?: string },
  idempotencyKey: string,
) {
  return call<{ updated: true; actionId: string; duplicate: boolean }>(
    await currentPortalSession(),
    `/v1/connections/${encodeURIComponent(connectionId)}/meta/groups/${encodeURIComponent(groupId)}`,
    {
      method: "PUT",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    },
  );
}

export async function getPrivacyRetentionPolicy() {
  return call<Row>(await currentPortalSession(), "/v1/privacy/retention-policy");
}

export async function updatePrivacyRetentionPolicy(input: {
  state: "ACTIVE" | "PAUSED";
  resolvedCaseDays: number;
  includeOpenCases: boolean;
  mediaDays: number;
  unmatchedDiagnosticHours: number;
  exportTtlHours: number;
  expectedVersion: number;
}) {
  return call<Row>(await currentPortalSession(), "/v1/privacy/retention-policy", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function getWorkspaceSettings() {
  return call<WorkspaceSettings>(await currentPortalSession(), "/v1/settings/workspace");
}

export async function updateWorkspaceSettings(input: Record<string, unknown>) {
  return call<WorkspaceSettings>(await currentPortalSession(), "/v1/settings/workspace", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function getTeamAccess(): Promise<TeamAccessData> {
  type TeamPage = TeamAccessData & { members_next_cursor?: string | null; invitations_next_cursor?: string | null };
  const session = await currentPortalSession();
  const first = await call<TeamPage>(session, "/v1/team");
  let page = first;
  const seen = new Set<string>();
  while (page.members_next_cursor || page.invitations_next_cursor) {
    const query = new URLSearchParams();
    if (page.members_next_cursor) query.set("member_cursor", page.members_next_cursor);
    if (page.invitations_next_cursor) query.set("invitation_cursor", page.invitations_next_cursor);
    const continuation = query.toString();
    if (seen.has(continuation)) throw new ControlPlaneError("The control plane repeated a team page cursor", 502);
    seen.add(continuation);
    page = await call<TeamPage>(session, "/v1/team?" + continuation);
    first.members.push(...page.members);
    first.invitations.push(...page.invitations);
  }
  return { members: first.members, invitations: first.invitations, capabilities: first.capabilities };
}

export async function workspaceAccess(input: Record<string, unknown>) {
  const session = await currentPortalSession();
  if (input.action === "status") return call<Row>(session, "/v1/team/workspace-access");
  if (input.action === "enable") return call<Row>(session, "/v1/team/workspace-access/enable", { method: "POST", body: "{}" });
  if (typeof input.userId !== "string" || !/^[0-9a-f-]{36}$/iu.test(input.userId)) throw Object.assign(new Error("Select a team member"), { status: 400 });
  const target = `/v1/team/workspace-access/${encodeURIComponent(input.userId)}`;
  if (input.action === "candidates") return call<Row>(session, `${target}/candidates`);
  if (input.action === "reconcile") return call<Row>(session, `${target}/reconcile`, { method: "POST", body: JSON.stringify({ expectedRevision: input.expectedRevision, adoptUserId: input.adoptUserId, prerequisiteChange: input.prerequisiteChange }) });
  throw Object.assign(new Error("Workspace access action is invalid"), { status: 400 });
}

export async function getSupportAccessRequests() {
  return call<Row[]>(await currentPortalSession(), "/v1/support-access");
}

export async function decideSupportAccess(
  id: string,
  action: "approve" | "deny" | "revoke",
  input: Record<string, unknown>,
) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/support-access/${encodeURIComponent(id)}/${action}`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function exportAuditCsv(input: {
  from: string;
  to: string;
  limit: number;
}) {
  const session = await currentPortalSession();
  const base = process.env.CONTROL_API_URL?.replace(/\/$/u, "");
  if (!base) throw new Error("CONTROL_API_URL is required");
  const query = new URLSearchParams({
    from: input.from,
    to: input.to,
    limit: String(input.limit),
  });
  const response = await fetch(`${base}/v1/audit-events/export?${query}`, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "x-wasalx-tenant-id": session.tenantId,
      accept: "text/csv",
      ...traceCarrierHeaders(),
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new ControlPlaneError("Audit export failed", response.status);
  }
  const body = await response.text();
  return {
    body,
    filename: auditFilename(response.headers.get("content-disposition"), input),
  };
}

export async function getMetaCostStatements(query:string){
  return call<Array<import("../packages/core/src/meta-cost").MetaCostStatementSummary>>(await currentPortalSession(),`/v1/meta/costs/statements?${query}`);
}
export async function getMetaCostStatement(id:string){
  return call<Record<string,unknown>>(await currentPortalSession(),`/v1/meta/costs/statements/${id}`);
}
export async function getMetaCostAccounts() {
  return call<Array<{id:string;names:string[]}>>(await currentPortalSession(), "/v1/meta/costs/accounts");
}

export async function getMetaCostUsage(query: string) {
  return call<import("../packages/core/src/meta-cost").MetaCostUsageSnapshot>(await currentPortalSession(), `/v1/meta/costs/usage?${query}`);
}

export async function exportMetaCostCsv(query: string, statements=false) {
  const session=await currentPortalSession(),base=process.env.CONTROL_API_URL?.replace(/\/$/u, "");
  if(!base)throw new Error("CONTROL_API_URL is required");
  const response=await fetch(`${base}/v1/meta/costs/${statements?"statements/":""}export?${query}`,{
    headers:{authorization:`Bearer ${session.accessToken}`,"x-wasalx-tenant-id":session.tenantId,accept:"text/csv",...traceCarrierHeaders()},
    cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15_000),
  });
  if(!response.ok)throw new ControlPlaneError("Cost export could not be completed; try a shorter period",response.status);
  if(!(response.headers.get("content-type")??"").startsWith("text/csv"))throw new Error("Cost export is unavailable");
  // The API rejects incomplete or over-10 MiB exports before returning bytes.
  const body=new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedBody(response,10*1024*1024,15_000));
  return body;
}

export async function inviteTeamMember(input: Record<string, unknown>, idempotencyKey: string) {
  return call<Row>(await currentPortalSession(), "/v1/team/invitations", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function resendTeamInvitation(id: string, input: Record<string, unknown>, idempotencyKey: string) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/team/invitations/${encodeURIComponent(id)}/resend`,
    { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) },
  );
}

export async function revokeTeamInvitation(id: string, expectedVersion: number) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/team/invitations/${encodeURIComponent(id)}/revoke`,
    { method: "POST", body: JSON.stringify({ expectedVersion }) },
  );
}

export async function updateTeamMember(id: string, input: Record<string, unknown>) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/team/members/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export async function removeTeamMember(id: string, expectedVersion: number) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/team/members/${encodeURIComponent(id)}`,
    { method: "DELETE", body: JSON.stringify({ expectedVersion }) },
  );
}

export async function getPrivacyLegalHolds() {
  return call<Row[]>(await currentPortalSession(), "/v1/privacy/legal-holds");
}

export async function createPrivacyLegalHold(input: {
  scopeType: string;
  scopeValue?: string;
  reason: string;
  expiresAt?: string;
}, operationId: string) {
  return call<Row>(await currentPortalSession(), "/v1/privacy/legal-holds", {
    method: "POST", headers: {"idempotency-key":operationId},
    body: JSON.stringify(input),
  });
}

export async function releasePrivacyLegalHold(id: string) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/privacy/legal-holds/${encodeURIComponent(id)}/release`,
    { method: "POST", body: "{}" },
  );
}

export async function privacyOperationReceipt(input: {operationId:string;kind:string;action:string}) {
  return call<Record<string,unknown>>(await currentPortalSession(),"/v1/privacy/receipt",{method:"POST",body:JSON.stringify(input)});
}

export async function resolvePrivacyTarget(input: { scopeType: string; scopeValue: string }) {
  return call<{ scope_type: string; display: string; selection_sha256: string }>(await currentPortalSession(), "/v1/privacy/target", {
    method: "POST", body: JSON.stringify(input),
  });
}

export async function getPrivacyRequests() {
  return call<Row[]>(await currentPortalSession(), "/v1/privacy/requests");
}

export async function getPrivacyRequest(id: string) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/privacy/requests/${encodeURIComponent(id)}`,
  );
}

export async function createPrivacyRequest(
  input: { requestType: "EXPORT" | "DELETE"; scopeType: string; scopeValue?: string; confirmation?: string },
  idempotencyKey: string,
) {
  return call<Row>(await currentPortalSession(), "/v1/privacy/requests", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function retryPrivacyRequest(id: string, confirmation: string | undefined, idempotencyKey: string) {
  return call<Row>(
    await currentPortalSession(),
    `/v1/privacy/requests/${encodeURIComponent(id)}/retry`,
    { method: "POST", headers:{"idempotency-key":idempotencyKey}, body: JSON.stringify({confirmation}) },
  );
}

export async function downloadPrivacyExport(id: string) {
  return call<{ url: string; expiresIn: number }>(
    await currentPortalSession(),
    `/v1/privacy/requests/${encodeURIComponent(id)}/download`,
    { method: "POST", body: "{}" },
  );
}

function normalizeConnection(row: Row) {
  return {
    ...row,
    phone: row.phone_e164 ?? null,
    group_count: Number(row.group_count ?? 0),
    last_event_at: row.last_provider_event_at ?? row.last_heartbeat_at,
  };
}

async function callList<T>(session: PortalSession, path: string) {
  const items: T[] = [];
  const seen = new Set<string>();
  const separator = path.includes("?") ? "&" : "?";
  let cursor: string | null = null;
  do {
    const target: string = cursor ? path + separator + "cursor=" + encodeURIComponent(cursor) : path;
    const page = await call<T[]>(session, target, {}, headers => { cursor = headers.get("x-next-cursor"); });
    for (const item of page) items.push(item);
    if (cursor) {
      if (seen.has(cursor)) throw new ControlPlaneError("The control plane repeated a page cursor", 502);
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

async function call<T>(
  session: PortalSession,
  path: string,
  init: RequestInit = {},
  onHeaders?: (headers: Headers) => void,
) {
  const base = process.env.CONTROL_API_URL?.replace(/\/$/, "");
  if (!base) throw new Error("CONTROL_API_URL is required");
  const propagated = traceCarrierHeaders();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${session.accessToken}`);
  headers.set("x-wasalx-tenant-id", session.tenantId);
  // Fastify rejects an empty request that advertises JSON. Lifecycle commands
  // such as start/restart/pause intentionally have no payload, so only declare
  // a representation when the bridge is actually forwarding a body.
  if (init.body !== undefined) headers.set("content-type", "application/json");
  else headers.delete("content-type");
  headers.set("accept", "application/json");
  for (const [name, value] of Object.entries(propagated)) if (!headers.has(name)) headers.set(name, value);
  const method = init.method?.toUpperCase() ?? "GET";
  const response = await withSpan("portal.control_plane.request", {
    attributes: {
      "wasalx.component": "portal_bff",
      "wasalx.operation": method,
      "wasalx.request_id": propagated["x-request-id"],
      "http.request.method": method,
    },
  }, (span) => fetch(`${base}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).then((result) => {
    span.setAttribute("http.response.status_code", result.status);
    return result;
  }));
  let body: unknown;
  try {
    body = await readBoundedJson(response, 10 * 1024 * 1024);
  } catch {
    // Keep confirmed access denials even when their body cannot supply trusted detail.
    throw new ControlPlaneError("The control plane returned an invalid response",
      response.status === 401 || response.status === 403 ? response.status : 502);
  }
  if (!response.ok) {
    const detail = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const workspaceProof = path === "/v1/inbox" && detail.code === "GROUP_ACCESS_DENIED" &&
      typeof detail.group_id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(detail.group_id)
      ? { group_id: detail.group_id } : path === "/v1/inbox" && detail.code === "GROUP_OPERATION_REJECTED" &&
        detail.effect === "NONE" && detail.terminal === true ? { effect: "NONE" as const, terminal: true as const } : undefined;

    throw new ControlPlaneError(
      typeof detail.message === "string" ? detail.message : typeof detail.error === "string" ? detail.error : "Control plane request failed",
      response.status,
      typeof detail.code === "string" ? detail.code : undefined,
      workspaceProof,
    );
  }
  onHeaders?.(response.headers);
  return body as T;
}

function auditFilename(
  disposition: string | null,
  input: { from: string; to: string },
) {
  const match = disposition?.match(/filename="([A-Za-z0-9._-]+)"/u);
  return match?.[1] ?? `wasalx-audit-${input.from.slice(0, 10)}-${input.to.slice(0, 10)}.csv`;
}

export async function metaTemplatePreparationPortalRequest(
  expected: { userId: string; tenantId: string }, id: string, suffix: string, method: "GET" | "POST", body?: unknown, key?: string,
) {
  const session = await currentPortalSession();
  if (session.userId !== expected.userId || session.tenantId !== expected.tenantId)
    throw new ControlPlaneError("Session context changed", 403);
  return call<unknown>(session, `/v1/connections/${encodeURIComponent(id)}/meta/template-preparations${suffix ? `/${suffix}` : ""}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
}

export async function metaLegacyMigrationPortalRequest(
  expected: { userId: string; tenantId: string }, id: string, suffix: string, method: "GET" | "POST", body?: unknown, key?: string,
) {
  const session = await currentPortalSession();
  if (session.userId !== expected.userId || session.tenantId !== expected.tenantId)
    throw new ControlPlaneError("Session context changed", 403);
  return call<unknown>(session, `/v1/connections/${encodeURIComponent(id)}/meta/legacy-migrations${suffix ? `/${suffix}` : ""}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
}


export async function portalInboxRequest(expected: { userId: string; tenantId: string }, body: unknown) {
  const session = await currentPortalSession();
  if (session.userId !== expected.userId || session.tenantId !== expected.tenantId)
    throw new ControlPlaneError("Session context changed", 403);
  return call<unknown>(session, "/v1/inbox", { method: "POST", body: JSON.stringify(body) });
}


export async function portalInboxAttachmentRequest(expected: { userId: string; tenantId: string }, input: unknown, operation: "ATTACHMENT" | "GROUP_MEDIA" = "ATTACHMENT") {
  const session = await currentPortalSession();
  if (session.userId !== expected.userId || session.tenantId !== expected.tenantId)
    throw new ControlPlaneError("Session context changed", 403);
  const base = process.env.CONTROL_API_URL?.replace(/\/$/, "");
  if (!base) throw new Error("CONTROL_API_URL is required");
  const response = await fetch(`${base}/v1/inbox`, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${session.accessToken}`, "x-wasalx-tenant-id": session.tenantId,
      "content-type": "application/json", accept: "application/octet-stream" },
    body: JSON.stringify({ operation, input }),
  });
  if (!response.ok) {
    if (response.status === 403 && operation === "GROUP_MEDIA") {
      const detail = await readBoundedJson<{code?: string; group_id?: string}>(response, 4_096).catch(() => null);
      const group = input && typeof input === "object" && !Array.isArray(input) ? (input as {group_id?: unknown}).group_id : undefined;
      if (detail?.code === "GROUP_ACCESS_DENIED" && typeof group === "string" && detail.group_id === group)
        throw new ControlPlaneError("Group access is unavailable", 403, "GROUP_ACCESS_DENIED", {group_id: group});
    }
    throw new ControlPlaneError("Attachment is unavailable", response.status);
  }
  const declared = response.headers.get("content-length");
  const length = Number(declared);
  if (!response.body || declared === null || !Number.isSafeInteger(length) || length < 0 || length > 50_000_000)
    throw new ControlPlaneError("Attachment is unavailable", 503);
  const nativeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const inline = operation === "GROUP_MEDIA" && WORKSPACE_INLINE_MEDIA_TYPES.has(nativeType);
  let total = 0;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (total !== length) throw new Error("Attachment is incomplete");
          reader.releaseLock(); controller.close(); return;
        }
        total += value.byteLength;
        if (total > length) throw new Error("Attachment size changed");
        controller.enqueue(value);
      } catch (error) { await reader.cancel().catch(() => undefined); reader.releaseLock(); controller.error(error); }
    },
    async cancel() { await reader.cancel().catch(() => undefined); reader.releaseLock(); },
  });
  return new Response(stream, { headers: { "content-type": inline ? nativeType : "application/octet-stream",
    "content-length": String(length), "content-disposition": inline ? "inline" : "attachment",
    "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

export async function portalInboxUploadRequest(expected: { userId: string; tenantId: string }, body: { operation: string; input: unknown },
  file: File, metadata: { filename: string; mime_type: string }) {
  const session = await currentPortalSession();
  if (session.userId !== expected.userId || session.tenantId !== expected.tenantId)
    throw new ControlPlaneError("Session context changed", 403);
  const base = process.env.CONTROL_API_URL?.replace(/\/$/, "");
  if (!base) throw new Error("CONTROL_API_URL is required");
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  const upload = { ...body, file: { ...metadata, byte_size: bytes.byteLength, sha256 } };
  const response = await fetch(`${base}/v1/inbox/upload`, { method: "POST", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(90_000), body: bytes,
    headers: { authorization: `Bearer ${session.accessToken}`, "x-wasalx-tenant-id": session.tenantId,
      "content-type": "application/vnd.wasalx.workspace-upload", "content-length": String(bytes.byteLength),
      "x-wasalx-upload-metadata": Buffer.from(JSON.stringify(upload)).toString("base64url") } });
  if (!response.ok) {
    if (response.status === 403 && body.operation === "GROUP_UPLOAD") {
      const detail = await readBoundedJson<{code?: string; group_id?: string}>(response, 4_096).catch(() => null);
      const group = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? (body.input as {group_id?: unknown}).group_id : undefined;
      if (detail?.code === "GROUP_ACCESS_DENIED" && typeof group === "string" && detail.group_id === group)
        throw new ControlPlaneError("Group access is unavailable", 403, "GROUP_ACCESS_DENIED", {group_id: group});
    }
    throw new ControlPlaneError("File staging is unavailable", response.status);
  }
  return readBoundedJson<unknown>(response, 16_384);
}
