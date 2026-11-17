import type { TriggerRule } from "./domain";
import { BOT_CONVERSATION_PAGE_SIZE, type BotConversationPageQuery } from "./bot-conversations.ts";
import { portalFixturePersona } from "./fixture-role.ts";
import { describeRuleChange } from "./rule-version-diff.ts";
import { botActionCapabilities } from "../packages/core/src/bot-action-capabilities.ts";
import { clientRoutingApplies,parseClientRouting,resolveClientRoute } from "../packages/core/src/client-routing.ts";
import { parseNativeRoutingSyncCommand, type NativeRoutingSyncStatus } from "../packages/core/src/native-routing-contract.ts";

const tenant={id:"tenant_northstar",name:"Northstar Logistics",slug:"northstar",plan:"Standard",accent:"#5B5BD6",runtime:"FIXTURE",default_theme:"DARK"};
const workspaceSettings={
  id:tenant.id,name:tenant.name,slug:tenant.slug,state:"ACTIVE",accent_color:tenant.accent,
  default_theme:"DARK",group_disclosure_enabled:true,
  group_disclosure_message:"Messages containing an operational reference may be copied to our support case system.",
  sso_enforcement_state:"REQUESTED",sso_provider_name:"Northstar Identity",sso_issuer:"https://identity.northstar.example",
  sso_email_domains:["northstar.example"],mfa_required_roles:["tenant_owner","tenant_admin"],
  session_timeout_minutes:480,privileged_reauth_minutes:15,support_access_requires_approval:true,security_policy_state:"REQUESTED",policy_verified_at:null,policy_verification_evidence_sha256:null,
  version:1,updated_at:new Date().toISOString(),
};
const groupWorkspaceSettings={group_workspace_enabled:true,group_history_default_retention_days:90,group_history_default_visibility:"RESTRICTED",version:1};
const groupWorkspaceGroups=new Map<string,Record<string,unknown>>();
const groupWorkspaceGrants=new Map<string,Array<Record<string,unknown>>>();
const now=()=>new Date().toISOString();
const nativeRoutingSync: NativeRoutingSyncStatus = { state: "UNCONFIGURED", desiredRevision: 0, appliedRevision: 0, desiredSha256: null, observedSha256: null, lastCheckedAt: null, errorCode: null, safeRetry: false, departmentDefaults: [] };
const nativeRoutingCommands = new Map<string, { body: string; result: NativeRoutingSyncStatus }>();
function markNativeRoutingSyncPending() {
  nativeRoutingSync.desiredRevision++;
  Object.assign(nativeRoutingSync, { state: "PENDING", desiredSha256: null, errorCode: null, safeRetry: true });
}
export async function getNativeRoutingSync(): Promise<NativeRoutingSyncStatus> { return structuredClone(nativeRoutingSync); }
export async function updateNativeRoutingSync(input: unknown, idempotencyKey: string): Promise<NativeRoutingSyncStatus> {
  const command = parseNativeRoutingSyncCommand(input);
  if (!idempotencyKey) throw Object.assign(new Error("NATIVE_ROUTING_VALIDATION_ERROR"), { status: 400, code: "NATIVE_ROUTING_VALIDATION_ERROR" });
  const body = JSON.stringify(command), previous = nativeRoutingCommands.get(idempotencyKey);
  if (previous) {
    if (previous.body !== body) throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { status: 409, code: "IDEMPOTENCY_CONFLICT" });
    return structuredClone(previous.result);
  }
  if (command.expectedRevision !== nativeRoutingSync.desiredRevision) throw Object.assign(new Error("NATIVE_ROUTING_REVISION_CONFLICT"), { status: 409, code: "NATIVE_ROUTING_REVISION_CONFLICT" });
  if (command.action === "SAVE_DEFAULTS") {
    const catalog = await getZammadRoutingCatalog();
    for (const policy of command.departmentDefaults.filter(row => row.enabled)) {
      if (!catalog.groups.some(group => group.id === policy.zammadGroupId && group.active && group.serviceIdentityCanCreate)
        || !catalog.owners.some(owner => owner.id === policy.zammadOwnerId && owner.active && owner.groupIds.includes(policy.zammadGroupId))) {
        throw Object.assign(new Error("NATIVE_ROUTING_TARGET_INVALID"), { status: 409, code: "NATIVE_ROUTING_TARGET_INVALID" });
      }
    }
    nativeRoutingSync.departmentDefaults = structuredClone(command.departmentDefaults);
    markNativeRoutingSyncPending();
  } else if (nativeRoutingSync.desiredRevision > 0) {
    // Fixture-only readback; this never calls or proves a live native workspace.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ revision: nativeRoutingSync.desiredRevision, defaults: nativeRoutingSync.departmentDefaults })));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    Object.assign(nativeRoutingSync, { state: "SYNCED", appliedRevision: nativeRoutingSync.desiredRevision, desiredSha256: hash, observedSha256: hash, lastCheckedAt: now(), errorCode: null, safeRetry: false });
  }
  const result = structuredClone(nativeRoutingSync);
  nativeRoutingCommands.set(idempotencyKey, { body, result });
  return structuredClone(result);
}
const ago=(minutes:number)=>new Date(Date.now()-minutes*60_000).toISOString();
const connections:Array<Record<string,unknown>>=[
  {id:"12000000-0000-4000-8000-000000000001",tenant_id:tenant.id,name:"Operations line",phone:"12025550100",provider:"WAHA",engine:"GOWS",state:"WORKING",provider_session_state:"WORKING",provider_state:"WORKING",worker_ready:true,onboarding_working_at:ago(3),last_heartbeat_at:now(),group_count:4,last_event_at:ago(2),action_reason:null},
  {id:"12000000-0000-4000-8000-000000000002",tenant_id:tenant.id,name:"Returns desk",phone:"12025550101",provider:"WAHA",engine:"NOWEB",state:"ACTION_REQUIRED",group_count:2,last_event_at:ago(120),action_reason:"Linked device authorization expired"},
];
const wahaOutboundPolicies=connections.map(connection=>({connection_id:String(connection.id),name:String(connection.name),phone_e164:String(connection.phone),enabled:true,inbound_response_only:true,allow_human_group_workspace_initiation:false,response_window_seconds:86_400,connection_capacity:3,connection_refill_tokens:1,connection_refill_seconds:30,number_capacity:5,number_refill_tokens:1,number_refill_seconds:30,minimum_spacing_seconds:5,version:1,reason:"Fixture policy",updated_at:now()}));
const groups:Array<Record<string,unknown>>=[
  {id:"grp_riyadh",tenant_id:tenant.id,connection_id:"12000000-0000-4000-8000-000000000001",name:"Riyadh · Last mile",external_group_id:"120363118@g.us",zammad_group:"Riyadh Operations",rule_name:"Ten-digit shipment ID",enabled:1,members:38,last_message_at:ago(4),activation_ready:true,activation_blocker_codes:[]},
  {id:"grp_jeddah",tenant_id:tenant.id,connection_id:"12000000-0000-4000-8000-000000000001",name:"Jeddah · Escalations",external_group_id:"120363204@g.us",zammad_group:"Escalations",rule_name:"ABC reference",enabled:1,members:22,last_message_at:ago(11),activation_ready:true,activation_blocker_codes:[]},
  {id:"grp_dammam",tenant_id:tenant.id,connection_id:"12000000-0000-4000-8000-000000000001",name:"Dammam · Linehaul",external_group_id:"120363338@g.us",zammad_group:"Linehaul",rule_name:"Ten-digit shipment ID",enabled:1,members:17,last_message_at:ago(26),activation_ready:true,activation_blocker_codes:[]},
  {id:"grp_vip",tenant_id:tenant.id,connection_id:"12000000-0000-4000-8000-000000000001",name:"VIP customers",external_group_id:"120363401@g.us",zammad_group:"Priority Support",rule_name:"VIP prefix",enabled:0,members:12,last_message_at:ago(50),activation_ready:false,activation_blocker_codes:["NO_ENABLED_RULES"]},
  {id:"grp_returns",tenant_id:tenant.id,connection_id:"12000000-0000-4000-8000-000000000002",name:"Returns approvals",external_group_id:"120363512@g.us",zammad_group:"Returns",rule_name:"ABC reference",enabled:1,members:29,last_message_at:ago(121),activation_ready:false,activation_blocker_codes:["CONNECTION_NOT_WORKING","PROVIDER_SESSION_NOT_WORKING"]},
];
const rules:TriggerRule[]=[
  {id:"rule_digits",name:"Ten-digit shipment ID",matcherType:"exact_length",pattern:"(?<!\\d)\\d{10}(?!\\d)",prefix:null,digitLength:10,priority:1,enabled:true,matchCount:1842,version:3},
  {id:"rule_abc",name:"ABC reference",matcherType:"prefix_length",pattern:"\\bABC\\d{7}\\b",prefix:"ABC",digitLength:7,priority:2,enabled:true,matchCount:626,version:2},
  {id:"rule_vip",name:"VIP prefix",matcherType:"starts_with",pattern:"VIP-",prefix:null,digitLength:null,priority:3,enabled:false,matchCount:51,version:1},
];
const ruleFamilyId="61000000-0000-4000-8000-000000000001";
const ruleSetVersions:Array<Record<string,unknown>>=[
  {id:"62000000-0000-4000-8000-000000000001",family_id:ruleFamilyId,name:"Operational references",version:2,state:"RETIRED",revision:2,snapshot_sha256:"fixture-v2",supersedes_rule_set_id:null,rollback_source_rule_set_id:null,created_at:ago(60*24*14),activated_at:ago(60*24*13),retired_at:ago(60*24*2),rules:[
    {id:"rule_digits_v2",name:"Ten-digit shipment ID",matcherType:"exact_length",pattern:"(?<!\\d)\\d{10}(?!\\d)",matcherOptions:{digitLength:10},priority:1,enabled:true,savedExamples:[{name:"Arabic digits",message:"Shipment ١٢٣٤٥٦٧٨٩٠",expectedMatches:["1234567890"]}]},
    {id:"rule_abc_v2",name:"ABC reference",matcherType:"prefix_length",pattern:"\\bABC\\d{7}\\b",matcherOptions:{prefix:"ABC",digitLength:7},priority:2,enabled:true,savedExamples:[{name:"ABC",message:"Case ABC1234567",expectedMatches:["ABC1234567"]}]},
  ]},
  {id:"62000000-0000-4000-8000-000000000002",family_id:ruleFamilyId,name:"Operational references",version:3,state:"ACTIVE",revision:3,snapshot_sha256:"fixture-v3",supersedes_rule_set_id:"62000000-0000-4000-8000-000000000001",rollback_source_rule_set_id:null,created_at:ago(60*24*2),activated_at:ago(60*24*2),retired_at:null,rules:rules.map(rule=>({id:rule.id,name:rule.name,matcherType:rule.matcherType,pattern:rule.pattern,matcherOptions:{prefix:rule.prefix,digitLength:rule.digitLength},priority:rule.priority,enabled:rule.enabled,savedExamples:[]}))},
  {id:"62000000-0000-4000-8000-000000000003",family_id:ruleFamilyId,name:"Operational references",version:4,state:"DRAFT",revision:1,snapshot_sha256:"fixture-v4",supersedes_rule_set_id:"62000000-0000-4000-8000-000000000002",rollback_source_rule_set_id:null,created_at:ago(65),activated_at:null,retired_at:null,rules:rules.map(rule=>({id:`${rule.id}_draft`,name:rule.name,matcherType:rule.matcherType,pattern:rule.pattern,matcherOptions:{prefix:rule.prefix,digitLength:rule.digitLength},priority:rule.priority,enabled:rule.enabled,savedExamples:[]}))},
];
const deliveries:Array<Record<string,unknown>>=[
  {id:"16000000-0000-4000-8000-000000000001",tenant_id:tenant.id,zammad_ticket_id:"10382",ticket_number:"#10382",group_name:"Riyadh · Last mile",destination_kind:"GROUP",message_body:"Driver has been reassigned. ETA 18 minutes.",state:"SENT",provider:"WAHA",attempts:1,error_message:null,manual_retry_allowed:false,receipt_count:2,last_receipt_status:"DELIVERED",last_receipt_scope:"PARTICIPANT_OBSERVED",last_receipt_at:ago(2),updated_at:ago(2)},
  {id:"16000000-0000-4000-8000-000000000002",tenant_id:tenant.id,zammad_ticket_id:"10381",ticket_number:"#10381",group_name:"Jeddah · Escalations",destination_kind:"GROUP",message_body:"We are checking the POD with the hub.",state:"OUTCOME_UNKNOWN",provider:"WAHA",attempts:1,error_message:"The provider connection closed before acceptance could be confirmed",manual_retry_allowed:false,updated_at:ago(6)},
  {id:"16000000-0000-4000-8000-000000000003",tenant_id:tenant.id,zammad_ticket_id:"10380",ticket_number:"#10380",group_name:"Returns approvals",destination_kind:"GROUP",message_body:"Return approved. Please use label RT-2391.",state:"FAILED_RETRYABLE",provider:"WAHA",attempts:2,error_message:"Session needs reauthorization",manual_retry_allowed:true,updated_at:ago(13)},
  {id:"16000000-0000-4000-8000-000000000004",tenant_id:tenant.id,zammad_ticket_id:"10379",ticket_number:"#10379",group_name:"Jeddah · Escalations",destination_kind:"GROUP",message_body:"Please review the attached archive.",state:"FAILED_TERMINAL",provider:"WAHA",attempts:1,error_message:"The attachment type is not supported",manual_retry_allowed:false,updated_at:ago(19)},
];
const reviews:Array<Record<string,unknown>>=[
  {id:"11111111-1111-4111-8111-111111111111",source_kind:"INBOUND",reason_code:"IDENTIFIER_LIMIT_EXCEEDED",state:"OPEN",safe_summary:"Message exceeded the configured identifier limit",safe_metadata:{reference_count:24,configured_limit:20},version:1,connection_name:"Operations line",provider:"WAHA",group_name:"Riyadh · Last mile",created_at:ago(8),updated_at:ago(8)},
  {id:"22222222-2222-4222-8222-222222222222",source_kind:"OUTBOUND",reason_code:"OUTBOUND_MEDIA_REJECTED",state:"OPEN",safe_summary:"Outbound media requires operator review",safe_metadata:{media_type:"application/zip",media_size:27000000,error_code:"INVALID_SIZE"},version:1,connection_name:"Operations line",provider:"WAHA",group_name:"Jeddah · Escalations",zammad_ticket_id:"10379",delivery_state:"FAILED_TERMINAL",created_at:ago(19),updated_at:ago(19)},
  {id:"33333333-3333-4333-8333-333333333333",source_kind:"OUTBOUND",reason_code:"PROVIDER_OUTCOME_UNKNOWN",delivery_id:"16000000-0000-4000-8000-000000000002",state:"OPEN",safe_summary:"Provider acceptance could not be confirmed; verify the group before retrying",safe_metadata:{attempt_count:1,error_code:"CONNECTION_CLOSED",retry_requires_confirmation:true},version:1,connection_name:"Operations line",provider:"WAHA",group_name:"Jeddah · Escalations",zammad_ticket_id:"10381",delivery_state:"OUTCOME_UNKNOWN",created_at:ago(6),updated_at:ago(6)},
  {id:"44444444-4444-4444-8444-444444444444",source_kind:"INBOUND",reason_code:"GROUP_ACTION_OUTCOME_UNKNOWN",state:"OPEN",safe_summary:"External action acceptance could not be confirmed; no retry is scheduled",safe_metadata:{action_key:"shipment.update",attempt_count:1},group_action_execution_id:"45000000-0000-4000-8000-000000000001",version:1,connection_name:"Operations line",provider:"WAHA",group_name:"Riyadh · Last mile",created_at:ago(5),updated_at:ago(5)},
];
const cases:Array<Record<string,unknown>>=[
  {id:"41000000-0000-4000-8000-000000000001",group_binding_id:"grp_riyadh",normalized_reference:"1234567890",zammad_ticket_id:"10382",zammad_ticket_number:"10382",state:"OPEN",generation:1,version:3,predecessor_correlation_id:null,replaced_by_correlation_id:null,zammad_state_id:2,zammad_state_observed_at:ago(2),detached_at:null,group_name:"Riyadh · Last mile",provider:"WAHA",zammad_group_id:"Riyadh Operations",created_at:ago(420),updated_at:ago(2)},
  {id:"41000000-0000-4000-8000-000000000002",group_binding_id:"grp_jeddah",normalized_reference:"ABC1234567",zammad_ticket_id:"10381",zammad_ticket_number:"10381",state:"RESOLVED",generation:1,version:2,predecessor_correlation_id:null,replaced_by_correlation_id:null,zammad_state_id:4,zammad_state_observed_at:ago(18),detached_at:null,group_name:"Jeddah · Escalations",provider:"WAHA",zammad_group_id:"Escalations",created_at:ago(920),updated_at:ago(18)},
  {id:"41000000-0000-4000-8000-000000000003",group_binding_id:"grp_dammam",normalized_reference:"7788990011",zammad_ticket_id:"10360",zammad_ticket_number:"10360",state:"DETACHED",generation:1,version:4,predecessor_correlation_id:null,replaced_by_correlation_id:"41000000-0000-4000-8000-000000000004",zammad_state_id:4,zammad_state_observed_at:ago(260),detached_at:ago(250),group_name:"Dammam · Linehaul",provider:"WAHA",zammad_group_id:"Linehaul",created_at:ago(1600),updated_at:ago(250)},
  {id:"41000000-0000-4000-8000-000000000004",group_binding_id:"grp_dammam",normalized_reference:"7788990011",zammad_ticket_id:"10377",zammad_ticket_number:"10377",state:"OPEN",generation:2,version:1,predecessor_correlation_id:"41000000-0000-4000-8000-000000000003",replaced_by_correlation_id:null,zammad_state_id:2,zammad_state_observed_at:ago(34),detached_at:null,group_name:"Dammam · Linehaul",provider:"WAHA",zammad_group_id:"Linehaul",created_at:ago(34),updated_at:ago(34)},
];
const audit:Array<Record<string,unknown>>=[
  {id:"aud_1",tenant_id:tenant.id,actor_type:"USER",actor:"Maya Al-Salem",action:"connection.reauth_requested",target:"Returns desk",detail:"Restarted secure authentication flow",request_id:"req_aud_1",created_at:ago(4)},
  {id:"aud_2",tenant_id:tenant.id,actor_type:"SYSTEM",actor:"WasalX system",action:"delivery.retry_scheduled",target:"#10380",detail:"Retry 3 scheduled with exponential backoff",request_id:"req_aud_2",created_at:ago(12)},
];
const teamMembers:Array<Record<string,unknown>>=[
  {id:"31000000-0000-4000-8000-000000000001",user_id:"local-preview",email:"maya@northstar.example",display_name:"Maya Al-Salem",role:"tenant_owner",state:"ACTIVE",version:1,created_at:ago(60*24*42),updated_at:ago(60*24*42),is_current_user:false},
  {id:"31000000-0000-4000-8000-000000000002",user_id:"32000000-0000-4000-8000-000000000002",email:"omar@northstar.example",display_name:"Omar Haddad",role:"tenant_admin",state:"ACTIVE",version:2,created_at:ago(60*24*30),updated_at:ago(60*24*7),is_current_user:false},
  {id:"31000000-0000-4000-8000-000000000003",user_id:"32000000-0000-4000-8000-000000000003",email:"sara@northstar.example",display_name:"Sara Khan",role:"supervisor",state:"ACTIVE",version:1,created_at:ago(60*24*18),updated_at:ago(60*24*18),is_current_user:false},
  {id:"31000000-0000-4000-8000-000000000004",user_id:"32000000-0000-4000-8000-000000000004",email:"faisal@northstar.example",display_name:"Faisal Noor",role:"auditor",state:"ACTIVE",version:3,created_at:ago(60*24*12),updated_at:ago(60*24),is_current_user:false},
  {id:"31000000-0000-4000-8000-000000000005",user_id:"32000000-0000-4000-8000-000000000005",email:"amal@northstar.example",display_name:"Amal Rahman",role:"agent",state:"ACTIVE",version:1,created_at:ago(60*24*5),updated_at:ago(60*24*5),is_current_user:false},
];
const teamInvitations:Array<Record<string,unknown>>=[
  {id:"33000000-0000-4000-8000-000000000001",email:"layla@northstar.example",display_name:"Layla Ahmed",role:"agent",state:"PENDING",expires_at:new Date(Date.now()+5*86_400_000).toISOString(),version:1,created_at:ago(25),updated_at:ago(25),delivery_state:"PENDING",delivery_attempts:0,delivery_error_code:null,delivery_error:null,delivery_updated_at:ago(25)},
];
const supportAccessRequests:Array<Record<string,unknown>>=[
  {id:"51000000-0000-4000-8000-000000000001",operator_email:"nora@wasalx.example",operator_display_name:"Nora · WasalX Support",reason:"Investigate repeated WAHA authorization failures on the Returns desk connection.",scope:"OPERATIONAL_METADATA",requested_duration_seconds:900,state:"PENDING",requested_at:ago(9),request_expires_at:new Date(Date.now()+23*60*60_000).toISOString(),approved_at:null,access_expires_at:null,denied_at:null,revoked_at:null,cancelled_at:null,decision_reason:null,version:1,created_at:ago(9),updated_at:ago(9)},
  {id:"51000000-0000-4000-8000-000000000002",operator_email:"support@wasalx.example",operator_display_name:"WasalX Reliability",reason:"Validate delivery queue recovery after the connector worker incident.",scope:"OPERATIONAL_METADATA",requested_duration_seconds:600,state:"APPROVED",requested_at:ago(42),request_expires_at:new Date(Date.now()+22*60*60_000).toISOString(),approved_at:ago(38),access_expires_at:new Date(Date.now()+6*60_000).toISOString(),denied_at:null,revoked_at:null,cancelled_at:null,decision_reason:null,version:2,created_at:ago(42),updated_at:ago(38)},
];
const privacyRetentionPolicy:Record<string,unknown>={
  state:"ACTIVE",resolved_case_days:365,include_open_cases:false,media_days:90,
  unmatched_diagnostic_hours:24,export_ttl_hours:24,next_sweep_at:new Date(Date.now()+32*60_000).toISOString(),
  version:3,updated_at:ago(60*24*5),zammad_privacy_configured:true,
};
const privacyLegalHolds:Array<Record<string,unknown>>=[
  {id:"71000000-0000-4000-8000-000000000001",scope_type:"ZAMMAD_TICKET",scope_value:"10381",scope_sha256:"8d3c9a5f4e7b2a19",reason:"Active customer dispute and evidence-preservation request",state:"ACTIVE",expires_at:new Date(Date.now()+28*86_400_000).toISOString(),created_by:"local-preview",released_by:null,released_at:null,created_at:ago(60*24*2),updated_at:ago(60*24*2)},
  {id:"71000000-0000-4000-8000-000000000002",scope_type:"REFERENCE",scope_value:"ABC7654321",scope_sha256:"77fb1c0a31cd801e",reason:"Completed legal review",state:"RELEASED",expires_at:null,created_by:"local-preview",released_by:"local-preview",released_at:ago(60*4),created_at:ago(60*24*20),updated_at:ago(60*4)},
];
const privacyRequests:Array<Record<string,unknown>>=[
  {id:"72000000-0000-4000-8000-000000000001",request_type:"EXPORT",scope_type:"REFERENCE",scope_value:"ABC1234567",scope_sha256:"354bd1208c1a4fb4",disposition:"EXPORT_ONLY",state:"SUCCEEDED",error_code:null,safe_error:null,completed_at:ago(18),created_at:ago(27),updated_at:ago(18),stage:"COMPLETED",attempts:1,max_attempts:8,summary:{ticket_count:1,message_count:6,byte_size:18432},artifact_id:"73000000-0000-4000-8000-000000000001",artifact_byte_size:18432,artifact_expires_at:new Date(Date.now()+10*60*60_000).toISOString()},
  {id:"72000000-0000-4000-8000-000000000002",request_type:"DELETE",scope_type:"ZAMMAD_TICKET",scope_value:"10381",scope_sha256:"8d3c9a5f4e7b2a19",disposition:"DELETE_TICKETS",state:"BLOCKED_LEGAL_HOLD",error_code:"LEGAL_HOLD_ACTIVE",safe_error:"An active legal hold blocks this privacy deletion.",completed_at:null,created_at:ago(44),updated_at:ago(42),stage:"DISCOVERY",attempts:1,max_attempts:8,summary:{targets_discovered:1},artifact_id:null,artifact_byte_size:null,artifact_expires_at:null},
  {id:"72000000-0000-4000-8000-000000000003",request_type:"EXPORT",scope_type:"PARTICIPANT",scope_value:"12025550100",scope_sha256:"92bc47ad303ce609",disposition:"EXPORT_ONLY",state:"FAILED_RETRYABLE",error_code:"OBJECT_STORAGE_UNAVAILABLE",safe_error:"Export storage is temporarily unavailable.",completed_at:null,created_at:ago(71),updated_at:ago(69),stage:"WRITE_ARTIFACT",attempts:2,max_attempts:8,summary:{targets_discovered:3},artifact_id:null,artifact_byte_size:null,artifact_expires_at:null},
];
const privacyRequestKeys=new Map<string,{digest:string;id:string}>();
const providerEvents=new Set<string>();
const outbox=new Map<string,{id:string;state:string;ticketId:string;articleId:string}>();
const caseDetachOperations=new Map<string,{correlationId:string;expectedVersion:number;result:Record<string,unknown>}>();
const botFamilyId="81000000-0000-4000-8000-000000000001";
const botFlows:Array<Record<string,unknown>>=[{family_id:botFamilyId,name:"Customer care",flow_version_id:"82000000-0000-4000-8000-000000000001",version:1,state:"ACTIVE",revision:2,snapshot_sha256:"fixture-bot-v1",assignment_count:1,created_at:ago(60*24*4),activated_at:ago(60*24*3),retired_at:null,definition:{schemaVersion:1,name:"Customer care",start:"welcome",maxSteps:30,nodes:[{id:"welcome",type:"choice",prompt:"How can we help?",options:[{id:"location",label:"Share my location",next:"location"},{id:"agent",label:"Talk to a person",next:"handoff"}]},{id:"location",type:"request_location",prompt:"Send your location and an agent will review it.",next:"handoff"},{id:"handoff",type:"handoff",target:"CLIENT_PRIMARY",priority:"2 normal",message:"A person will join shortly."}]}}];
const botActions:Array<Record<string,unknown>>=[{id:"83000000-0000-4000-8000-000000000001",action_key:"notion.create_case",name:"Create Notion case",kind:"NOTION_CREATE_PAGE",endpoint_url:"https://api.notion.com/v1/pages",http_method:"POST",auth_scheme:"BEARER",secret_reference:"secret://tenants/tenant_northstar/bot-actions/notion",headers:{},response_mapping:{"action.page_url":"/url"},timeout_ms:5000,max_response_bytes:262144,state:"PAUSED",revision:1,created_at:ago(60*24),updated_at:ago(60*24)}];
const botActionRevisions=new Map<string,Array<Record<string,unknown>>>(botActions.map(row=>[String(row.action_key),[{...structuredClone(row),id:`${String(row.id)}:${String(row.revision)}`}]]));
const botActionQualifications=new Map<string,Record<string,unknown>>();
const botAssignments:Array<Record<string,unknown>>=[{id:"84000000-0000-4000-8000-000000000001",connection_id:"12000000-0000-4000-8000-000000000001",connection_name:"Operations line",provider:"WAHA",engine:"GOWS",flow_family_id:botFamilyId,flow_name:"Customer care",flow_version_id:"82000000-0000-4000-8000-000000000001",version:1,zammad_group_id:"2",agent_prefix:"Agent:",agent_identity_placement:"HEADER",state:"ACTIVE",revision:1,created_at:ago(60*24*3),updated_at:ago(60*24*3)}];
const botConversations:Array<Record<string,unknown>>=[{id:"85000000-0000-4000-8000-000000000001",flow_version_id:"82000000-0000-4000-8000-000000000001",state:"HUMAN",current_node_id:"handoff",step_count:3,fencing_token:2,zammad_ticket_number:"10421",last_activity_at:ago(8),resolved_at:null,connection_name:"Operations line",flow_name:"Customer care",version:1,handoff_state:"SUCCEEDED",handoff_attempts:1,handoff_safe_error:null,action_node_id:null,action_state:null,action_safe_error:null,timeline:[{kind:"HANDOFF_COMPLETED",from:"handoff",to:"handoff",metadata:{zammad_ticket:true},at:ago(8)},{kind:"HANDOFF_REQUESTED",from:"location",to:"handoff",metadata:{priority:"2 normal"},at:ago(9)},{kind:"ACTION_SUCCEEDED",from:"location",to:"handoff",at:ago(10)},{kind:"ACTION_RETRY_REQUESTED",from:"location",to:"location",at:ago(11)},{kind:"ACTION_FAILED",from:"location",to:"location",at:ago(12)}]},{id:"85000000-0000-4000-8000-000000000002",flow_version_id:"82000000-0000-4000-8000-000000000099",state:"ACTION_PENDING",current_node_id:"lookup",step_count:2,fencing_token:3,zammad_ticket_number:"10422",last_activity_at:ago(5),resolved_at:null,connection_name:"Operations line",flow_name:"Order lookup",version:1,handoff_state:null,handoff_attempts:null,handoff_safe_error:null,action_node_id:"lookup",action_state:"OUTCOME_UNKNOWN",action_safe_error:"The order system may have accepted the request, but its response was not received.",timeline:[{kind:"ACTION_OUTCOME_UNKNOWN",from:"lookup",to:"lookup",at:ago(5)}]}];
const clientRoutingVersions:Array<Record<string,unknown>>=[{id:"86000000-0000-4000-8000-000000000001",version:1,state:"ACTIVE",revision:2,snapshot_sha256:"fixture-client-routing-v1",created_at:ago(60*24*3),activated_at:ago(60*24*3),retired_at:null,definition:{schemaVersion:1,name:"Client ownership",supportGroupIds:["2"],fallback:{zammadGroupId:"2"},sources:[{id:"manual",name:"Manual overrides",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}},{id:"notion",name:"Notion client directory",kind:"NOTION",syncMode:"HYBRID",secretReference:"secret://tenants/tenant_northstar/routing/notion",endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",scheduleMinutes:15,fieldMapping:{client_id:"Client ID",domains:"Domains",owner_id:"Zammad owner ID"}}],clients:[{id:"acme",name:"Acme Logistics",routeSourceId:"notion",zammadGroupId:"2",ownerId:"12",escalationGroupId:"4",matchers:[{kind:"EMAIL",sourceId:"notion",value:"support@acme.example"},{kind:"DOMAIN",sourceId:"notion",value:"acme.example"},{kind:"CLIENT_IDENTIFIER",sourceId:"notion",namespace:"notion",value:"ACME-42"}]}]}}];
const clientRoutingIntegrations:Array<Record<string,unknown>>=[{id:"87000000-0000-4000-8000-000000000001",provider:"NOTION",display_name:"Northstar workspace",auth_scheme:"BEARER",binding_reference:"secret://tenants/tenant_northstar/routing/integrations/87000000-0000-4000-8000-000000000001",state:"CONNECTED",revision:2,source_id:"notion",last_success_at:ago(4),latest_test_state:"SUCCEEDED",latest_test_safe_error:null}];
const clientRoutingQualifications:Array<Record<string,unknown>>=[];

export async function getDashboardData(){return{tenant:{...tenant,role:fixturePersona().role},connections:structuredClone(connections),groups:structuredClone(groups),rules:structuredClone(rules),deliveries:deliveries.map(item=>({...publicDelivery(item),excerpt:"Message content redacted",body_available:true})),audit:structuredClone(audit)}}
export async function getBotFlows():Promise<Array<Record<string,unknown>>>{return structuredClone(botFlows.map(flow=>({...flow,name:String((flow.definition as Record<string,unknown>)?.name??flow.name),assignment_count:botAssignments.filter(assignment=>assignment.state==="ACTIVE"&&assignment.flow_version_id===flow.flow_version_id).length})))}
export async function getBotActions(){return structuredClone(botActions.map(row=>({...row,capabilities:botActionCapabilities({kind:row.kind,endpointUrl:row.endpoint_url,httpMethod:row.http_method,authScheme:row.auth_scheme,secretReference:row.secret_reference})})))}
export async function getBotAssignments(){return structuredClone(botAssignments.map(assignment=>{const flow=botFlows.find(row=>row.flow_version_id===assignment.flow_version_id);const connection=connections.find(row=>row.id===assignment.connection_id);return{...assignment,flow_name:String((flow?.definition as Record<string,unknown>|undefined)?.name??flow?.name??assignment.flow_name),version:flow?.version??assignment.version,connection_state:connection?.state??"FAILED"}}))}
export async function getBotConversations(input:BotConversationPageQuery={}){
  const limit=fixtureInteger(input.limit??BOT_CONVERSATION_PAGE_SIZE,1,100,"Conversation page limit");
  const cursor=input.cursor===undefined?null:fixtureConversationCursor(input.cursor);
  const ordered=botConversations.map<Record<string,unknown>>(conversation=>{const flow=botFlows.find(row=>row.flow_version_id===conversation.flow_version_id);return{...conversation,flow_name:String((flow?.definition as Record<string,unknown>|undefined)?.name??flow?.name??conversation.flow_name),version:flow?.version??conversation.version}}).sort((left,right)=>{
    const activity=String(right.last_activity_at).localeCompare(String(left.last_activity_at));
    return activity||String(right.id).localeCompare(String(left.id));
  });
  const eligible=cursor?ordered.filter(row=>String(row.last_activity_at)<cursor.at||(String(row.last_activity_at)===cursor.at&&String(row.id)<cursor.id)):ordered;
  const items=eligible.slice(0,limit);
  return{items:structuredClone(items),next_cursor:eligible.length>limit?encodeFixtureConversationCursor(items.at(-1)!):null};
}
export async function getBotConversationEvents(conversationId:string,input:BotConversationPageQuery={}){
  const conversation=botConversations.find(row=>row.id===conversationId);
  if(!conversation)throw Object.assign(new Error("Bot conversation was not found"),{status:404});
  const limit=fixtureInteger(input.limit??BOT_CONVERSATION_PAGE_SIZE,1,100,"Conversation event page limit");
  const timeline=(Array.isArray(conversation.timeline)?conversation.timeline:[]).map((event,index)=>({
    id:`${conversationId}:${String(index+1).padStart(4,"0")}`,
    kind:String((event as Record<string,unknown>).kind??""),
    from:(event as Record<string,unknown>).from==null?null:String((event as Record<string,unknown>).from),
    to:(event as Record<string,unknown>).to==null?null:String((event as Record<string,unknown>).to),
    at:String((event as Record<string,unknown>).at??conversation.last_activity_at),
  })).sort((left,right)=>right.at.localeCompare(left.at)||right.id.localeCompare(left.id));
  const cursor=input.cursor===undefined?null:fixtureConversationEventCursor(input.cursor,conversationId);
  const eligible=cursor?timeline.filter(row=>row.at<cursor.at||(row.at===cursor.at&&row.id<cursor.id)):timeline;
  const items=eligible.slice(0,limit);
  const overlayEvents=timeline.filter(row=>["ACTION_SUCCEEDED","ACTION_FAILED","ACTION_OUTCOME_UNKNOWN","ACTION_RETRY_REQUESTED","HANDOFF_REQUESTED","HANDOFF_COMPLETED","HANDOFF_SUCCEEDED"].includes(row.kind)).map(({kind,from,to,at})=>({kind,from,to,at}));
  return{items:structuredClone(items),next_cursor:eligible.length>limit?encodeFixtureConversationEventCursor(conversationId,items.at(-1)!):null,overlay_events:structuredClone(overlayEvents)};
}
export async function getClientRouting(){return structuredClone(clientRoutingVersions)}
export async function getClientRoutingCapabilities(){return{externalConnectorsEnabled:true,notionOAuthEnabled:true}}
export async function getClientRoutingSources(){return[{source_id:"notion",kind:"NOTION",sync_mode:"HYBRID",state:"ACTIVE",snapshot_revision:8,snapshot_sha256:"fixture-routing-source",last_success_at:ago(4),next_due_at:ago(-11),safe_error:null,latest_job_state:"SUCCEEDED",latest_trigger_kind:"SCHEDULED",latest_job_attempts:1,latest_job_safe_error:null,latest_job_at:ago(4),webhook_path:`/webhooks/routing/${"r".repeat(43)}`}]}
export async function getClientRoutingIntegrations(){return structuredClone(clientRoutingIntegrations)}
export async function storeClientRoutingCredential(input:Record<string,unknown>){const replaced=clientRoutingIntegrations.find(row=>row.id===input.integrationId);if(input.integrationId&&(!replaced||Number(replaced.revision)!==Number(input.expectedRevision)))throw Object.assign(new Error("Routing credential changed; refresh before updating"),{status:409});if(replaced)replaced.state="REVOKED";const id=crypto.randomUUID();const row={id,provider:input.provider,display_name:input.displayName,auth_scheme:input.authScheme,binding_reference:`secret://tenants/${tenant.id}/routing/integrations/${id}`,state:"CONNECTED",revision:2,source_id:null,last_success_at:null,latest_test_state:null,latest_test_safe_error:null};clientRoutingIntegrations.push(row);return{integrationId:id,provider:row.provider,displayName:row.display_name,authScheme:row.auth_scheme,bindingReference:row.binding_reference,revision:2,duplicate:false}}
export async function testClientRoutingCredential(id:string,input:Record<string,unknown>){const row=clientRoutingIntegrations.find(item=>item.id===id);if(!row||Number(row.revision)!==Number(input.expectedRevision))throw Object.assign(new Error("Routing credential changed; refresh before testing"),{status:409});if(!row.source_id)throw Object.assign(new Error("Use this connection in an active routing version before testing it"),{status:409});row.latest_test_state="QUEUED";return{integrationId:id,jobId:crypto.randomUUID(),sourceId:row.source_id,snapshotRevision:8,alreadyPending:false,duplicate:false}}
export async function getClientRoutingQualifications(versionId:string){if(!clientRoutingVersions.some(row=>row.id===versionId))throw Object.assign(new Error("Client routing version was not found"),{status:404});return structuredClone(clientRoutingQualifications.filter(row=>row.routing_version_id===versionId))}
export async function qualifyClientRoutingSource(versionId:string,sourceId:string,input:Record<string,unknown>){const version=clientRoutingVersions.find(row=>row.id===versionId);const integration=clientRoutingIntegrations.find(row=>row.id===input.integrationId);if(!version||version.state!=="DRAFT"||Number(version.revision)!==Number(input.expectedRoutingRevision)||!integration||Number(integration.revision)!==Number(input.expectedIntegrationRevision))throw Object.assign(new Error("Routing connection changed; refresh before testing"),{status:409});const qualificationId=crypto.randomUUID();const jobId=crypto.randomUUID();clientRoutingQualifications.unshift({qualification_id:qualificationId,routing_version_id:versionId,source_id:sourceId,integration_id:integration.id,integration_revision:integration.revision,job_id:jobId,state:"SUCCEEDED",attempts:1,safe_error:null,updated_at:now()});return{qualificationId,jobId,routingVersionId:versionId,sourceId,duplicate:false}}
export async function startNotionRoutingOAuth(){return{authorizationUrl:"https://api.notion.com/v1/oauth/authorize?fixture=1",integrationId:"87000000-0000-4000-8000-000000000001"}}
export async function completeNotionRoutingOAuth(input:Record<string,unknown>){void input;return{integrationId:"87000000-0000-4000-8000-000000000001",provider:"NOTION",displayName:"Northstar workspace",revision:2}}
export async function abortNotionRoutingOAuth(input:Record<string,unknown>){void input;return{aborted:true,integrationId:"87000000-0000-4000-8000-000000000001"}}
export async function syncClientRoutingSource(id:string,input:Record<string,unknown>){if(id!=="notion"||Number(input.expectedSnapshotRevision)!==8)throw Object.assign(new Error("Routing source changed; refresh before syncing"),{status:409});return{jobId:crypto.randomUUID(),sourceId:id,snapshotRevision:8,alreadyPending:false,duplicate:false}}
export async function createClientRouting(input:Record<string,unknown>){const definition=parseClientRouting(input);const row={id:crypto.randomUUID(),version:Math.max(0,...clientRoutingVersions.map(item=>Number(item.version)))+1,state:"DRAFT",revision:1,snapshot_sha256:`fixture-routing-${crypto.randomUUID()}`,created_at:now(),activated_at:null,retired_at:null,definition:structuredClone(definition)};clientRoutingVersions.push(row);return{id:row.id,version:row.version,state:row.state,revision:row.revision,snapshotSha256:row.snapshot_sha256,duplicate:false}}
export async function activateClientRouting(id:string,input:Record<string,unknown>){const target=clientRoutingVersions.find(row=>row.id===id);if(!target||target.state!=="DRAFT"||Number(target.revision)!==Number(input.expectedRevision))throw Object.assign(new Error("Client routing changed; refresh before activation"),{status:409});const active=clientRoutingVersions.find(row=>row.state==="ACTIVE");if(active){active.state="RETIRED";active.revision=Number(active.revision)+1;active.retired_at=now()}target.state="ACTIVE";target.revision=Number(target.revision)+1;target.activated_at=now();markNativeRoutingSyncPending();return{routingVersionId:id,retiredRoutingVersionId:active?.id??null,revision:target.revision,duplicate:false}}
export async function simulateClientRouting(input:Record<string,unknown>){const row=clientRoutingVersions.find(item=>item.id===input.versionId)??clientRoutingVersions.find(item=>item.state==="ACTIVE");if(!row)throw Object.assign(new Error("An active client routing version was not found"),{status:404});const definition=parseClientRouting(row.definition),match=input.match as Record<string,string>;return{routingVersionId:row.id,version:row.version,...(clientRoutingApplies(definition,match.entryGroupId)?resolveClientRoute(definition,match):{status:"DEPARTMENT"})}}
export async function saveBotAction(input:Record<string,unknown>){const key=String(input.actionKey);const existing=botActions.find(row=>row.action_key===key);if(existing){Object.assign(existing,{name:input.name,kind:input.kind,endpoint_url:input.endpointUrl,http_method:input.httpMethod,auth_scheme:input.authScheme,secret_reference:input.secretReference,headers:input.headers,response_mapping:input.responseMapping,timeout_ms:input.timeoutMs,max_response_bytes:input.maxResponseBytes,state:input.state,revision:Number(existing.revision)+1,updated_at:now()});botActionRevisions.get(key)?.push({...structuredClone(existing),id:`${String(existing.id)}:${String(existing.revision)}`});return{id:existing.id,actionKey:key,revision:existing.revision,state:existing.state}}const row={id:crypto.randomUUID(),action_key:key,name:input.name,kind:input.kind,endpoint_url:input.endpointUrl,http_method:input.httpMethod,auth_scheme:input.authScheme,secret_reference:input.secretReference,headers:input.headers,response_mapping:input.responseMapping,timeout_ms:input.timeoutMs,max_response_bytes:input.maxResponseBytes,state:input.state,revision:1,created_at:now(),updated_at:now()};botActions.push(row);botActionRevisions.set(key,[{...structuredClone(row),id:`${String(row.id)}:1`}]);return{id:row.id,actionKey:key,revision:1,state:row.state}}
export async function getBotActionRevisions(actionKey:string){const action=botActions.find(row=>row.action_key===actionKey);if(!action)throw Object.assign(new Error("Bot action was not found"),{status:404});return structuredClone((botActionRevisions.get(actionKey)??[]).toSorted((left,right)=>Number(right.revision)-Number(left.revision)).map(row=>({...row,active:Number(row.revision)===Number(action.revision)})))}
export async function restoreBotActionRevision(actionKey:string,revision:number,input:Record<string,unknown>){const action=botActions.find(row=>row.action_key===actionKey);const source=botActionRevisions.get(actionKey)?.find(row=>Number(row.revision)===revision);if(!action||!source)throw Object.assign(new Error("Plugin revision was not found"),{status:404});if(Number(action.revision)!==Number(input.expectedRevision))throw Object.assign(new Error("Bot action changed; refresh before restoring"),{status:409});return saveBotAction({actionKey,name:source.name,kind:source.kind,endpointUrl:source.endpoint_url,httpMethod:source.http_method,authScheme:source.auth_scheme,secretReference:source.secret_reference,headers:source.headers,responseMapping:source.response_mapping,timeoutMs:source.timeout_ms,maxResponseBytes:source.max_response_bytes,state:source.state})}
export async function qualifyBotAction(actionKey:string,input:Record<string,unknown>){const action=botActions.find(row=>row.action_key===actionKey);const capabilities=action&&botActionCapabilities({kind:action.kind,endpointUrl:action.endpoint_url,httpMethod:action.http_method,authScheme:action.auth_scheme,secretReference:action.secret_reference});if(!action||action.state!=="ACTIVE"||Number(action.revision)!==Number(input.expectedRevision)||capabilities?.retry_semantics!=="REPLAY_SAFE")throw Object.assign(new Error("Bot action changed or cannot be checked safely"),{status:409});const qualificationId=crypto.randomUUID();botActionQualifications.set(qualificationId,{qualificationId,actionKey,actionRevision:Number(action.revision),state:"SUCCEEDED",outcome:"SUCCESS",createdAt:now(),updatedAt:now(),completedAt:now()});return{qualificationId,actionKey,actionRevision:Number(action.revision),state:"QUEUED",duplicate:false}}
export async function getBotActionQualification(actionKey:string,id:string){const row=botActionQualifications.get(id);if(!row||row.actionKey!==actionKey)throw Object.assign(new Error("Plugin action qualification was not found"),{status:404});return structuredClone(row)}
export async function storeBotActionCredential(input:Record<string,unknown>){return{secretReference:`secret://tenants/${tenant.id}/bot-actions/${String(input.actionKey)}`}}
export async function createBotFlow(input:Record<string,unknown>){const familyId=crypto.randomUUID();const id=crypto.randomUUID();botFlows.push({family_id:familyId,name:input.name,flow_version_id:id,version:1,state:"DRAFT",revision:1,snapshot_sha256:`fixture-${id}`,assignment_count:0,created_at:now(),activated_at:null,retired_at:null,definition:structuredClone(input)});record(fixturePersona().displayName,"bot_flow.created",id,"Created immutable bot flow draft version 1");return{familyId,id,version:1,state:"DRAFT",revision:1,duplicate:false}}
export async function cloneBotFlow(id:string,input:Record<string,unknown>){const source=botFlows.find(row=>row.flow_version_id===id);if(!source)throw Object.assign(new Error("Bot flow version was not found"),{status:404});const version=Math.max(...botFlows.filter(row=>row.family_id===source.family_id).map(row=>Number(row.version)))+1;const created={...structuredClone(source),flow_version_id:crypto.randomUUID(),name:input.name,definition:structuredClone(input),version,state:"DRAFT",revision:1,created_at:now(),activated_at:null,retired_at:null};botFlows.push(created);record(fixturePersona().displayName,"bot_flow.cloned",String(created.flow_version_id),`Cloned bot flow version ${String(source.version)} into immutable version ${version}`);return{familyId:source.family_id,id:created.flow_version_id,version,state:"DRAFT",revision:1,duplicate:false}}
export async function activateBotFlow(id:string,input:Record<string,unknown>){const target=botFlows.find(row=>row.flow_version_id===id);if(!target||target.state!=="DRAFT"||Number(target.revision)!==Number(input.expectedRevision))throw Object.assign(new Error("Bot flow changed; refresh before activation"),{status:409});const active=botFlows.find(row=>row.family_id===target.family_id&&row.state==="ACTIVE");if(active){active.state="RETIRED";active.retired_at=now()}target.state="ACTIVE";target.revision=Number(target.revision)+1;target.activated_at=now();for(const assignment of botAssignments)if(assignment.flow_family_id===target.family_id){assignment.flow_version_id=target.flow_version_id;assignment.version=target.version;assignment.revision=Number(assignment.revision)+1}markNativeRoutingSyncPending();record(fixturePersona().displayName,"bot_flow.activated",id,`Activated bot flow version ${String(target.version)}${active?`; retired version ${String(active.version)}`:""}`);return{flowVersionId:id,retiredFlowVersionId:active?.flow_version_id??null,revision:target.revision,assignmentsMigrated:botAssignments.filter(row=>row.flow_family_id===target.family_id).length,duplicate:false}}
export async function assignBotFlow(input:Record<string,unknown>){const flow=botFlows.find(row=>row.family_id===input.familyId&&row.state==="ACTIVE");const connection=connections.find(row=>row.id===input.connectionId);if(!flow||!connection)throw Object.assign(new Error("Bot flow or connection is unavailable"),{status:409});let row=botAssignments.find(item=>item.connection_id===input.connectionId);const attribution={agent_prefix:input.agentPrefix??row?.agent_prefix??"Agent:",agent_identity_placement:input.agentIdentityPlacement??row?.agent_identity_placement??"HEADER"};if(row)Object.assign(row,{flow_family_id:input.familyId,flow_name:flow.name,flow_version_id:flow.flow_version_id,version:flow.version,zammad_group_id:input.zammadGroupId,...attribution,state:"ACTIVE",revision:Number(row.revision)+1,updated_at:now()});else{row={id:crypto.randomUUID(),connection_id:input.connectionId,connection_name:connection.name,provider:connection.provider,engine:connection.engine,flow_family_id:input.familyId,flow_name:flow.name,flow_version_id:flow.flow_version_id,version:flow.version,zammad_group_id:input.zammadGroupId,...attribution,state:"ACTIVE",revision:1,created_at:now(),updated_at:now()};botAssignments.push(row)}markNativeRoutingSyncPending();return{assignmentId:row.id,flowVersionId:row.flow_version_id,...input,agentPrefix:row.agent_prefix,agentIdentityPlacement:row.agent_identity_placement,revision:row.revision,duplicate:false}}
export async function setBotAssignmentState(id:string,input:Record<string,unknown>){const row=botAssignments.find(item=>item.id===id);if(!row||Number(row.revision)!==Number(input.expectedRevision))throw Object.assign(new Error("Bot assignment changed; refresh before updating it"),{status:409});row.state=input.state;row.revision=Number(row.revision)+1;row.updated_at=now();markNativeRoutingSyncPending();return{assignmentId:id,state:row.state,revision:row.revision}}
export async function setBotAssignmentAttribution(id:string,input:Record<string,unknown>){const row=botAssignments.find(item=>item.id===id);if(!row||Number(row.revision)!==Number(input.expectedRevision))throw Object.assign(new Error("Bot assignment changed; refresh before updating its message attribution"),{status:409});row.agent_prefix=input.agentPrefix;row.agent_identity_placement=input.agentIdentityPlacement;row.revision=Number(row.revision)+1;row.updated_at=now();return{assignmentId:id,agentPrefix:row.agent_prefix,agentIdentityPlacement:row.agent_identity_placement,revision:row.revision}}
export async function commandBotConversation(id:string,input:Record<string,unknown>){const row=botConversations.find(item=>item.id===id);if(!row||Number(row.fencing_token)!==Number(input.expectedFencingToken))throw Object.assign(new Error("Bot conversation changed; refresh before updating it"),{status:409});if(input.action==="RETRY_HANDOFF"){row.handoff_state="QUEUED";row.handoff_safe_error=null;row.state="HANDOFF_PENDING"}else if(input.action==="RETRY_ACTION"){row.action_state="FAILED_RETRYABLE";row.action_safe_error=null;row.state="ACTION_PENDING"}else if(input.action==="HANDOFF_TO_HUMAN")row.state="HUMAN";else if(input.action==="RESUME_BOT"){row.state="BOT";row.current_node_id="welcome";row.step_count=0}else row.state="RESOLVED";row.fencing_token=Number(row.fencing_token)+1;row.resolved_at=input.action==="CLOSE"?now():null;row.last_activity_at=now();return{conversationId:id,state:row.state,currentNodeId:row.current_node_id,fencingToken:row.fencing_token,command:input.action}}
export async function getDeliveryDetail(id:string){const item=deliveries.find(row=>row.id===id);if(!item)throw new Error("Delivery was not found");return{...publicDelivery(item),receipts:id==="16000000-0000-4000-8000-000000000001"?[{id:"receipt-1",receipt_scope:"PARTICIPANT_OBSERVED",receipt_status:"SENT",provider_status:"SERVER",provider_timestamp:ago(3),error_codes:[],safe_metadata:{ack:1,engine:"GOWS",groupReceipt:true},applied_state:"OBSERVED",created_at:ago(3)},{id:"receipt-2",receipt_scope:"PARTICIPANT_OBSERVED",receipt_status:"DELIVERED",provider_status:"DEVICE",provider_timestamp:ago(2),error_codes:[],safe_metadata:{ack:2,engine:"GOWS",groupReceipt:true},applied_state:"OBSERVED",created_at:ago(2)}]:[],delivery_attempts:[{id:`attempt-${id}-1`,attempt_number:1,state:String(item.state),provider_code:null,safe_error:item.error_message??null,started_at:item.updated_at,finished_at:item.updated_at}]}}
export async function revealDeliveryContent(id:string,actor:string){const item=deliveries.find(row=>row.id===id);if(!item)throw Object.assign(new Error("Delivery was not found"),{status:404});record(actor,"delivery.content_revealed",String(item.ticket_number),"Revealed one outbound message for an authorized operational review");return{body:String(item.message_body??""),revealed_at:now(),expires_in_seconds:60}}
export async function getCases(input:{ticket?:string}={}){return structuredClone(input.ticket?cases.filter(row=>row.zammad_ticket_number===input.ticket):cases)}
export async function detachCase(id:string,expectedVersion:number,actor:string,idempotencyKey:string){
  const replay=caseDetachOperations.get(idempotencyKey);
  if(replay){
    if(replay.correlationId!==id||replay.expectedVersion!==expectedVersion)throw Object.assign(new Error("Idempotency key was already used for a different detach request"),{status:409});
    return{...structuredClone(replay.result),duplicate:true};
  }
  const item=cases.find(row=>row.id===id);if(!item)throw Object.assign(new Error("Case correlation was not found"),{status:404});
  if(item.state==="DETACHED")throw Object.assign(new Error("Case correlation is already detached"),{status:409});
  if(Number(item.version)!==expectedVersion)throw Object.assign(new Error("Case correlation changed; refresh before starting a new case"),{status:409});
  Object.assign(item,{state:"DETACHED",version:Number(item.version)+1,detached_at:now(),updated_at:now()});record(actor,"case.correlation_detached",String(item.zammad_ticket_number),"Detached the identifier; the next match starts a linked generation");
  const result={...structuredClone(item),next_generation:Number(item.generation)+1,successor_correlation_id:null,message:"The next matching message will create a linked case generation.",duplicate:false};
  caseDetachOperations.set(idempotencyKey,{correlationId:id,expectedVersion,result});
  return result;
}
export async function getReviewItems(state?:string){return structuredClone(reviews.filter(item=>!state||item.state===state))}
export async function getReviewItem(id:string){const item=reviews.find(row=>row.id===id);if(!item)throw new Error("Review item was not found");return{...structuredClone(item),rule_options:item.source_kind==="INBOUND"?rules.filter(rule=>rule.enabled).map(rule=>({id:rule.id,name:rule.name,matcher_type:rule.matcherType,pattern:rule.pattern,matcher_options:{prefix:rule.prefix,digitLength:rule.digitLength},priority:rule.priority})):[]}}
export async function reviewAction(id:string,action:"resolve"|"discard"|"reprocess",input:Record<string,unknown>){const item=reviews.find(row=>row.id===id);if(!item)throw new Error("Review item was not found");if(item.state!=="OPEN"||Number(item.version)!==Number(input.expectedVersion))throw new Error("Review item changed; reload before acting");item.version=Number(item.version)+1;item.updated_at=now();item.state=action==="resolve"?"RESOLVED":action==="discard"?"DISCARDED":"REPROCESS_QUEUED";return{id,state:item.state,version:item.version,duplicate:false}}
export async function getWorkspaceSettings(){return structuredClone(workspaceSettings)}
export async function updateWorkspaceSettings(input:Record<string,unknown>,actor:string){
  if(Number(input.expectedVersion)!==workspaceSettings.version)throw Object.assign(new Error("The workspace changed; reload before saving"),{status:409});
  const next={
    name:String(input.name??workspaceSettings.name),slug:String(input.slug??workspaceSettings.slug),
    accent_color:String(input.accentColor??workspaceSettings.accent_color),default_theme:String(input.defaultTheme??workspaceSettings.default_theme),
    group_disclosure_enabled:Boolean(input.groupDisclosureEnabled),group_disclosure_message:String(input.groupDisclosureMessage??workspaceSettings.group_disclosure_message),
    sso_enforcement_state:input.ssoEnforcementRequested?"REQUESTED":"DISABLED",sso_provider_name:input.ssoProviderName?String(input.ssoProviderName):null,
    sso_issuer:input.ssoIssuer?String(input.ssoIssuer):null,sso_email_domains:Array.isArray(input.ssoEmailDomains)?input.ssoEmailDomains.map(String):[],
    mfa_required_roles:Array.isArray(input.mfaRequiredRoles)?input.mfaRequiredRoles.map(String):["tenant_owner"],
    session_timeout_minutes:Number(input.sessionTimeoutMinutes),privileged_reauth_minutes:Number(input.privilegedReauthMinutes),
    support_access_requires_approval:Boolean(input.supportAccessRequiresApproval),security_policy_state:"REQUESTED",policy_verified_at:null,policy_verification_evidence_sha256:null,version:workspaceSettings.version+1,updated_at:now(),
  };
  Object.assign(workspaceSettings,next);Object.assign(tenant,{name:next.name,slug:next.slug,accent:next.accent_color});
  record(actor,"settings.workspace_updated",tenant.id,"Updated workspace, identity, and security policy metadata");
  return structuredClone(workspaceSettings);
}
function fixturePersona(){return portalFixturePersona()??{userId:"local-preview",displayName:"Maya Al-Salem",email:"maya@northstar.example",fullName:"Maya Al-Salem",role:"tenant_owner" as const}}
function isCurrentFixtureMember(member:Record<string,unknown>){return member.user_id===fixturePersona().userId}
export async function getTeamAccess(){
  const persona=fixturePersona();const canManage=persona.role==="tenant_owner"||persona.role==="tenant_admin";
  return{members:structuredClone(teamMembers.map(member=>({...member,is_current_user:isCurrentFixtureMember(member),nativeObservation:{state:"UNVERIFIED",checkedAt:null,revision:0,nativeUserId:null}}))),invitations:canManage?structuredClone(teamInvitations):[],capabilities:{can_invite:canManage,can_manage_members:canManage,can_manage_owners:persona.role==="tenant_owner"}};
}
export async function inviteTeamMember(input:Record<string,unknown>,actor:string){
  const persona=fixturePersona();const requestedRole=String(input.role??"agent");
  if(persona.role!=="tenant_owner"&&persona.role!=="tenant_admin")throw Object.assign(new Error("Your role cannot invite workspace members"),{status:403});
  if(persona.role==="tenant_admin"&&requestedRole==="tenant_owner")throw Object.assign(new Error("Tenant administrators cannot invite owners"),{status:403});
  const email=String(input.email??"").trim().toLowerCase();
  if(teamMembers.some(item=>item.email===email))throw Object.assign(new Error("This person already belongs to the workspace"),{status:409});
  if(teamInvitations.some(item=>item.email===email&&item.state==="PENDING"))throw Object.assign(new Error("A pending invitation already exists; resend or revoke it instead"),{status:409});
  const invitation={id:crypto.randomUUID(),email,display_name:String(input.displayName??"").trim()||null,role:String(input.role??"agent"),state:"PENDING",expires_at:new Date(Date.now()+Number(input.expiresInDays??7)*86_400_000).toISOString(),version:1,created_at:now(),updated_at:now(),delivery_state:"PENDING",delivery_attempts:0,delivery_error_code:null,delivery_error:null,delivery_updated_at:now()};
  teamInvitations.unshift(invitation);record(actor,"team.invitation_created",email,"Queued a single-use invitation for email delivery");return structuredClone({...invitation,duplicate:false});
}
export async function resendTeamInvitation(id:string,input:Record<string,unknown>,actor:string){
  const invitation=teamInvitations.find(item=>item.id===id);if(!invitation)throw Object.assign(new Error("Invitation not found"),{status:404});
  if(fixturePersona().role==="tenant_admin"&&invitation.role==="tenant_owner")throw Object.assign(new Error("Tenant administrators cannot manage owner invitations"),{status:403});
  if(invitation.state==="ACCEPTED"||invitation.state==="REVOKED")throw Object.assign(new Error(`A ${String(invitation.state).toLowerCase()} invitation cannot be resent`),{status:409});
  if(invitation.delivery_state==="SENDING")throw Object.assign(new Error("Invitation delivery is already in progress"),{status:409});
  if(invitation.delivery_error_code==="INVITATION_DELIVERY_OUTCOME_UNKNOWN"&&input.confirmUnknownDelivery!==true)throw Object.assign(new Error("Check the destination mailbox, then explicitly confirm the resend"),{status:409});
  Object.assign(invitation,{state:"PENDING",expires_at:new Date(Date.now()+Number(input.expiresInDays??7)*86_400_000).toISOString(),version:Number(invitation.version)+1,updated_at:now(),delivery_state:"PENDING",delivery_attempts:0,delivery_error_code:null,delivery_error:null,delivery_updated_at:now()});
  record(actor,"team.invitation_resent",String(invitation.email),"Rotated the single-use token and queued a new email");return structuredClone({...invitation,duplicate:false});
}
export async function revokeTeamInvitation(id:string,expectedVersion:number,actor:string){
  const invitation=teamInvitations.find(item=>item.id===id);if(!invitation)throw Object.assign(new Error("Invitation not found"),{status:404});
  if(fixturePersona().role==="tenant_admin"&&invitation.role==="tenant_owner")throw Object.assign(new Error("Tenant administrators cannot manage owner invitations"),{status:403});
  if(Number(invitation.version)!==expectedVersion)throw Object.assign(new Error("The invitation changed; reload before revoking it"),{status:409});
  if(invitation.delivery_state==="SENDING")throw Object.assign(new Error("Invitation delivery is already in progress"),{status:409});
  Object.assign(invitation,{state:"REVOKED",version:Number(invitation.version)+1,updated_at:now(),delivery_state:"CANCELLED",delivery_error_code:null,delivery_updated_at:now()});
  record(actor,"team.invitation_revoked",String(invitation.email),"Revoked the invitation and cancelled queued delivery");return structuredClone({...invitation,duplicate:false});
}
export async function updateTeamMember(id:string,input:Record<string,unknown>,actor:string){
  const member=teamMembers.find(item=>item.id===id);if(!member)throw Object.assign(new Error("Team member not found"),{status:404});
  if(isCurrentFixtureMember(member)&&!(input.role===member.role&&input.state===member.state&&input.whatsappNumbers!==undefined))throw Object.assign(new Error("You cannot change your own workspace access"),{status:403});
  const persona=fixturePersona();if(persona.role!=="tenant_owner"&&persona.role!=="tenant_admin")throw Object.assign(new Error("Your role cannot manage workspace access"),{status:403});
  if(persona.role==="tenant_admin"&&(member.role==="tenant_owner"||input.role==="tenant_owner"))throw Object.assign(new Error("Tenant administrators cannot change owner access"),{status:403});
  if(Number(member.version)!==Number(input.expectedVersion))throw Object.assign(new Error("The membership changed; reload before saving"),{status:409});
  const numbers=input.whatsappNumbers===undefined?undefined:Array.isArray(input.whatsappNumbers)?input.whatsappNumbers.map(value=>typeof value==="string"?value.trim().replace(/[\s()-]/g,""):""):null;
  if(numbers===null||numbers?.some(value=>!/^\+[1-9][0-9]{1,14}$/.test(value)))throw Object.assign(new Error("Enter WhatsApp numbers in international format"),{status:400});
  if(numbers&&new Set(numbers).size!==numbers.length)throw Object.assign(new Error("WhatsApp numbers must not contain duplicates"),{status:400});
  Object.assign(member,{role:String(input.role),state:String(input.state),...(numbers!==undefined?{whatsapp_numbers:numbers}:{}),version:Number(member.version)+1,updated_at:now()});
  record(actor,"team.membership_updated",String(member.email),`Updated role to ${member.role} and state to ${member.state}`);return structuredClone(member);
}
export async function removeTeamMember(id:string,expectedVersion:number,actor:string){
  const index=teamMembers.findIndex(item=>item.id===id);if(index<0)throw Object.assign(new Error("Team member not found"),{status:404});
  const member=teamMembers[index]!;if(isCurrentFixtureMember(member))throw Object.assign(new Error("You cannot remove your own workspace access"),{status:403});
  const persona=fixturePersona();if(persona.role!=="tenant_owner"&&persona.role!=="tenant_admin")throw Object.assign(new Error("Your role cannot manage workspace access"),{status:403});
  if(persona.role==="tenant_admin"&&member.role==="tenant_owner")throw Object.assign(new Error("Tenant administrators cannot change owner access"),{status:403});
  if(Number(member.version)!==expectedVersion)throw Object.assign(new Error("The membership changed; reload before removing it"),{status:409});
  teamMembers.splice(index,1);record(actor,"team.membership_removed",String(member.email),"Removed workspace membership");return{id,removed:true};
}
export async function getPrivacyRetentionPolicy(){return structuredClone(privacyRetentionPolicy)}
export async function updatePrivacyRetentionPolicy(input:Record<string,unknown>,actor:string){
  if(Number(input.expectedVersion)!==Number(privacyRetentionPolicy.version))throw Object.assign(new Error("The retention policy changed; reload it before saving"),{status:409});
  const state=String(input.state);if(state!=="ACTIVE"&&state!=="PAUSED")throw Object.assign(new Error("Policy state is invalid"),{status:400});
  const resolvedCaseDays=fixtureInteger(input.resolvedCaseDays,1,3650,"Resolved-case retention");
  const mediaDays=fixtureInteger(input.mediaDays,1,3650,"Media retention");
  const unmatchedDiagnosticHours=fixtureInteger(input.unmatchedDiagnosticHours,1,24,"Unmatched diagnostic retention");
  const exportTtlHours=fixtureInteger(input.exportTtlHours,1,168,"Export lifetime");
  if(typeof input.includeOpenCases!=="boolean")throw Object.assign(new Error("Open-case retention choice is required"),{status:400});
  Object.assign(privacyRetentionPolicy,{state,resolved_case_days:resolvedCaseDays,include_open_cases:input.includeOpenCases,media_days:mediaDays,unmatched_diagnostic_hours:unmatchedDiagnosticHours,export_ttl_hours:exportTtlHours,next_sweep_at:now(),version:Number(privacyRetentionPolicy.version)+1,updated_at:now()});
  record(actor,"privacy.retention_policy_updated",tenant.id,"Updated retention durations and lifecycle state");return structuredClone(privacyRetentionPolicy);
}
const fixturePrivacyAdmissions = new Map<string,{kind:string;requestedBy:string;digest:string;result:Record<string,unknown>}>();
function fixturePrivacyActor(){return portalFixturePersona()?.userId ?? "local-preview"}
function fixturePrivacyKey(key:unknown){if(typeof key!=="string"||!key||key.length>255||/\s/u.test(key))throw Object.assign(new Error("Valid operation key required"),{status:400});return key;}
function fixturePrivacyReplay(kind:string,key:string,digest?:string): (Record<string,unknown> & {duplicate:boolean}) | null {
 const row=fixturePrivacyAdmissions.get(key);if(!row)return null;
 if(row.requestedBy!==fixturePrivacyActor())throw Object.assign(new Error("Receipt unavailable"),{status:403});
 if(row.kind!==kind||row.result.state!=="NOT_APPLIED"&&digest&&row.digest!==digest)throw Object.assign(new Error("Operation intent changed"),{status:409});
 return {...row.result,duplicate:true};
}
export async function privacyOperationReceipt(input:{operationId:string;kind:string;action:string},role=portalFixturePersona()?.role ?? "tenant_owner"){
 if(!["EXPORT","DELETE","HOLD"].includes(input.kind)||!["LOOKUP","CANCEL_IF_UNADMITTED"].includes(input.action))throw Object.assign(new Error("Invalid receipt"),{status:400});
 if(role!=="tenant_owner"&&(role!=="tenant_admin"||input.kind!=="EXPORT"))throw Object.assign(new Error("Receipt unavailable"),{status:403});
 const key=fixturePrivacyKey(input.operationId),prior=fixturePrivacyReplay(input.kind,key);
 if(prior)return prior.state==="NOT_APPLIED"?{state:"NOT_APPLIED",terminal:true,effect:"NONE"}:{state:"APPLIED",id:prior.id};
 if(input.action==="LOOKUP")return{state:"UNKNOWN"};
 const result={state:"NOT_APPLIED",terminal:true,effect:"NONE"};fixturePrivacyAdmissions.set(key,{kind:input.kind,requestedBy:fixturePrivacyActor(),digest:"cancel",result});return result;
}
const fixturePrivacyTargets = [
  { type: "ZAMMAD_TICKET", reference: "2026101810381", id: "10381", display: "#2026101810381" },
  { type: "ZAMMAD_USER", reference: "customer@example.test", id: "7001", display: "Synthetic customer · customer@example.test" },
] as const;
export async function resolvePrivacyTarget(input: { scopeType?: unknown; scopeValue?: unknown }, role = portalFixturePersona()?.role ?? "tenant_owner") {
  if (role !== "tenant_owner" && role !== "tenant_admin") throw Object.assign(new Error("Target selection is unavailable"), { status: 403 });
  const type = String(input.scopeType ?? "").toUpperCase();
  const reference = String(input.scopeValue ?? "");
  const target = fixturePrivacyTargets.find(row => row.type === type && row.reference === (type === "ZAMMAD_USER" ? reference.toLowerCase().trim() : reference));
  if (!target) throw Object.assign(new Error("Target is unavailable"), { status: 403 });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([tenant.id, portalFixturePersona()?.userId ?? "local-preview", target.type, target.reference, target.id])));
  const selection_sha256 = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
  return { scope_type: target.type, display: target.display, selection_sha256 };
}
async function fixturePrivacyAdmission(input: Record<string, unknown>, allowGroup: boolean) {
  const type = String(input.scopeType ?? "").toUpperCase();
  if (type !== "ZAMMAD_TICKET" && type !== "ZAMMAD_USER") return { ...fixturePrivacyScope(type, input.scopeValue, allowGroup), display: null };
  if (typeof input.selection_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.selection_sha256)) throw Object.assign(new Error("Confirm the selected target first"), { status: 400 });
  const selected = await resolvePrivacyTarget(input);
  if (input.selection_sha256 !== selected.selection_sha256) throw Object.assign(new Error("Target changed. Confirm it again."), { status: 409 });
  const target = fixturePrivacyTargets.find(row => row.type === selected.scope_type)!;
  return { type: target.type, value: target.id, display: type === "ZAMMAD_TICKET" ? target.display : null };
}
function publicFixturePrivacy<T extends Record<string, unknown>>(row: T, reveal: boolean): T & { scope_value: string | null } {
  const captured = (row as T & { scope_display?: string | null }).scope_display;
  return { ...row, scope_value: !reveal ? null : row.scope_type === "ZAMMAD_TICKET" ? captured ?? null : row.scope_type === "ZAMMAD_USER" ? null : typeof row.scope_value === "string" ? row.scope_value : null };
}
export async function getPrivacyLegalHolds(reveal=true){return structuredClone(privacyLegalHolds.map(hold=>({...publicFixturePrivacy(hold,reveal),...(!reveal?{reason:"Restricted"}:{})})))}
export async function createPrivacyLegalHold(input:Record<string,unknown>,actor:string,operationId:string){
  fixturePrivacyKey(operationId);const intentDigest=JSON.stringify(input);const replay=fixturePrivacyReplay("HOLD",operationId,intentDigest);if(replay)return replay;
  const scope=await fixturePrivacyAdmission(input,true);const reason=String(input.reason??"").trim();
  if(!reason||reason.length>500)throw Object.assign(new Error("A legal-hold reason is required"),{status:400});
  const active=privacyLegalHolds.find(hold=>hold.state==="ACTIVE"&&hold.scope_type===scope.type&&hold.scope_value===scope.value);if(active)throw Object.assign(new Error("An active legal hold already covers this scope"),{status:409});
  const expiresAt=input.expiresAt?new Date(String(input.expiresAt)):null;if(expiresAt&&(!Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now()))throw Object.assign(new Error("Legal-hold expiry must be in the future"),{status:400});
  const hold={id:crypto.randomUUID(),scope_type:scope.type,scope_value:scope.value,scope_display:scope.display,scope_sha256:crypto.randomUUID().replaceAll("-","").slice(0,16),reason,state:"ACTIVE",expires_at:expiresAt?.toISOString()??null,created_by:actor,released_by:null,released_at:null,created_at:now(),updated_at:now()};
  privacyLegalHolds.unshift(hold);fixturePrivacyAdmissions.set(operationId,{kind:"HOLD",requestedBy:fixturePrivacyActor(),digest:intentDigest,result:{id:hold.id,state:hold.state}});record(actor,"privacy.legal_hold_created",hold.id,`Created ${scope.type.toLowerCase()} legal hold`);return structuredClone(publicFixturePrivacy(hold,true));
}
export async function releasePrivacyLegalHold(id:string,actor:string){
  const hold=privacyLegalHolds.find(item=>item.id===id&&item.state==="ACTIVE");if(!hold)throw Object.assign(new Error("Active legal hold not found"),{status:404});
  Object.assign(hold,{state:"RELEASED",released_by:actor,released_at:now(),updated_at:now()});record(actor,"privacy.legal_hold_released",id,"Released active legal hold after explicit portal confirmation");return{id,state:"RELEASED",released_at:hold.released_at};
}
export async function getPrivacyRequests(reveal=true){return structuredClone(privacyRequests.map(item=>{const copy={...item};delete copy.stage;delete copy.attempts;delete copy.max_attempts;delete copy.summary;return publicFixturePrivacy(copy,reveal)}))}
export async function getPrivacyRequest(id:string,reveal=true){const item=privacyRequests.find(request=>request.id===id);if(!item)throw Object.assign(new Error("Privacy request not found"),{status:404});return structuredClone(publicFixturePrivacy(item,reveal))}
export async function createPrivacyRequest(input:Record<string,unknown>,idempotencyKey:string,actor:string){
  const requestType=String(input.requestType??"").toUpperCase();if(requestType!=="EXPORT"&&requestType!=="DELETE")throw Object.assign(new Error("Request type must be EXPORT or DELETE"),{status:400});
  const intent={type:String(input.scopeType??"TENANT").toUpperCase(),value:input.scopeValue,selection_sha256:input.selection_sha256};const confirmation=intent.type==="TENANT"?"DELETE TENANT DATA":"DELETE";
  if(requestType==="DELETE"&&input.confirmation!==confirmation)throw Object.assign(new Error(`Type "${confirmation}" to confirm deletion`),{status:400});
  fixturePrivacyKey(idempotencyKey);const admissionDigest=JSON.stringify({requestType,intent});const recovered=fixturePrivacyReplay(requestType,idempotencyKey,admissionDigest);if(recovered)return recovered;
  const digest=JSON.stringify({requestType,intent});const prior=privacyRequestKeys.get(idempotencyKey);if(prior){if(prior.digest!==digest)throw Object.assign(new Error("The idempotency key was already used for another privacy request"),{status:409});const existing=privacyRequests.find(item=>item.id===prior.id);return{id:prior.id,state:existing?.state??"QUEUED",duplicate:true}}
  const scope=await fixturePrivacyAdmission(input,false);
  if(requestType==="DELETE"&&privacyLegalHolds.some(hold=>hold.state==="ACTIVE"&&(scope.type==="TENANT"||(hold.scope_type===scope.type&&hold.scope_value===scope.value))))throw Object.assign(new Error("An active legal hold blocks this deletion scope"),{status:409});
  const request={id:crypto.randomUUID(),request_type:requestType,scope_type:scope.type,scope_value:scope.value,scope_display:scope.display,scope_sha256:crypto.randomUUID().replaceAll("-","").slice(0,16),disposition:requestType==="EXPORT"?"EXPORT_ONLY":scope.type==="ZAMMAD_USER"?"ZAMMAD_USER_DATA_PRIVACY":"DELETE_TICKETS",state:"QUEUED",error_code:null,safe_error:null,completed_at:null,created_at:now(),updated_at:now(),stage:"DISCOVERY",attempts:0,max_attempts:8,summary:{targets_discovered:0},artifact_id:null,artifact_byte_size:null,artifact_expires_at:null};
  privacyRequests.unshift(request);fixturePrivacyAdmissions.set(idempotencyKey,{kind:requestType,requestedBy:fixturePrivacyActor(),digest:admissionDigest,result:{id:request.id,state:request.state}});privacyRequestKeys.set(idempotencyKey,{digest,id:request.id});record(actor,requestType==="EXPORT"?"privacy.export_requested":"privacy.deletion_requested",request.id,`Queued ${requestType.toLowerCase()} for ${scope.type.toLowerCase()} scope`);return{id:request.id,state:"QUEUED",duplicate:false};
}
export async function retryPrivacyRequest(id:string,confirmation:string|undefined,idempotencyKey:string,actor:string){const request=privacyRequests.find(item=>item.id===id);if(!request)throw Object.assign(new Error("Privacy request not found"),{status:404});const expected=request.scope_type==="TENANT"?"DELETE TENANT DATA":"DELETE";if(request.request_type==="DELETE"&&confirmation!==expected)throw Object.assign(new Error(`Type "${expected}" to confirm deletion`),{status:400});if(!idempotencyKey)throw Object.assign(new Error("A valid Idempotency-Key header is required"),{status:400});const digest=JSON.stringify({action:"retry",id,confirmation:request.request_type==="DELETE"?confirmation:null});const prior=privacyRequestKeys.get(idempotencyKey);if(prior){if(prior.digest!==digest)throw Object.assign(new Error("The idempotency key was already used for another privacy retry"),{status:409});return{id:prior.id,state:"QUEUED",duplicate:true}}if(!["FAILED_RETRYABLE","FAILED_TERMINAL","BLOCKED_LEGAL_HOLD"].includes(String(request.state)))throw Object.assign(new Error("Privacy request is not retryable"),{status:400});if(request.request_type==="DELETE"&&privacyLegalHolds.some(hold=>hold.state==="ACTIVE"&&(request.scope_type==="TENANT"||(hold.scope_type===request.scope_type&&hold.scope_value===request.scope_value))))throw Object.assign(new Error("An active legal hold still blocks this deletion"),{status:409});Object.assign(request,{state:"QUEUED",error_code:null,safe_error:null,completed_at:null,updated_at:now(),stage:"DISCOVERY",attempts:0});privacyRequestKeys.set(idempotencyKey,{digest,id});record(actor,"privacy.request_retry_requested",id,"Returned privacy request to the durable queue");return{id,state:"QUEUED",duplicate:false}}
export async function downloadPrivacyExport(id:string,actor:string){const request=privacyRequests.find(item=>item.id===id&&item.request_type==="EXPORT"&&item.state==="SUCCEEDED"&&item.artifact_id&&new Date(String(item.artifact_expires_at)).getTime()>Date.now());if(!request)throw Object.assign(new Error("A downloadable export artifact is not available"),{status:404});record(actor,"privacy.export_downloaded",id,"Issued a five-minute synthetic signed-download link");return{url:`https://downloads.wasalx.example.invalid/privacy/${encodeURIComponent(id)}?fixture-signature=redacted`,expiresIn:300}}
export async function getSupportAccessRequests(){
  const timestamp=Date.now();
  for(const request of supportAccessRequests){
    if(request.state==="APPROVED"&&new Date(String(request.access_expires_at)).getTime()<=timestamp){request.state="EXPIRED";request.version=Number(request.version)+1;request.updated_at=now()}
    if(request.state==="PENDING"&&new Date(String(request.request_expires_at)).getTime()<=timestamp){request.state="EXPIRED";request.version=Number(request.version)+1;request.updated_at=now()}
  }
  return structuredClone(supportAccessRequests);
}
export async function decideSupportAccess(id:string,action:"approve"|"deny"|"revoke",input:Record<string,unknown>,actor:string){
  const request=supportAccessRequests.find(item=>item.id===id);if(!request)throw Object.assign(new Error("Support access request was not found"),{status:404});
  if(Number(input.expectedVersion)!==Number(request.version))throw Object.assign(new Error("Support access request changed; reload before deciding"),{status:409});
  if(action==="approve"){
    if(request.state!=="PENDING")throw Object.assign(new Error("Only a pending request can be approved"),{status:409});
    const requested=Number(request.requested_duration_seconds);const granted=Number(input.durationSeconds??requested);
    if(!Number.isInteger(granted)||granted<300||granted>requested)throw Object.assign(new Error("Granted duration must be between five minutes and the requested duration"),{status:400});
    Object.assign(request,{state:"APPROVED",approved_at:now(),access_expires_at:new Date(Date.now()+granted*1_000).toISOString(),decision_reason:null,version:Number(request.version)+1,updated_at:now()});
    record(actor,"support_access.approved",id,`Approved metadata-only access for ${granted} seconds`);
  }else{
    const reason=String(input.reason??"").trim();if(reason.length<3)throw Object.assign(new Error("A decision reason is required"),{status:400});
    if(action==="deny"&&request.state!=="PENDING")throw Object.assign(new Error("Only a pending request can be denied"),{status:409});
    if(action==="revoke"&&request.state!=="APPROVED")throw Object.assign(new Error("Only active access can be revoked"),{status:409});
    Object.assign(request,{state:action==="deny"?"DENIED":"REVOKED",decision_reason:reason,denied_at:action==="deny"?now():request.denied_at,revoked_at:action==="revoke"?now():request.revoked_at,access_expires_at:action==="revoke"?now():request.access_expires_at,version:Number(request.version)+1,updated_at:now()});
    record(actor,action==="deny"?"support_access.denied":"support_access.revoked",id,reason);
  }
  return structuredClone(request);
}
export async function getGroupConfiguration(id:string){
  const group=groups.find(row=>row.id===id);
  if(!group)throw new Error("WhatsApp group was not found");
  const connection=connections.find(row=>row.id===group.connection_id);
  const selectedRule=rules.find(rule=>rule.id===group.rule_set_id)||rules.find(rule=>rule.name===group.rule_name);
  return{
    ...structuredClone(group),
    display_name:String(group.wasalx_name??group.name),
    provider_display_name:String(group.provider_display_name??group.name),
    wasalx_name:group.wasalx_name??group.name,
    provider:String(connection?.provider??"WAHA"),
    phone_e164:connection?.phone?String(connection.phone):null,
    connection_state:String(connection?.state??"FAILED"),
    zammad_state:"WORKING",
    working_session_count:connection?.state==="WORKING"?1:0,
    rule_set_id:String(group.rule_set_id??selectedRule?.id??""),
    zammad_group_id:String(group.zammad_group_id??zammadGroupId(String(group.zammad_group??""))??""),
    default_priority:String(group.default_priority??"normal"),
    assignment_mode:String(group.assignment_mode??"zammad_auto"),
    fixed_owner_id:group.fixed_owner_id??null,
    sla_policy_id:group.sla_policy_id??null,
    business_hours_mode:String(group.business_hours_mode??"ALWAYS"),
    business_hours_calendar_id:group.business_hours_calendar_id??null,
    acknowledgement_template:String(group.acknowledgement_template??"Case {{tickets}} is now being tracked by WasalX."),
    agent_prefix:String(group.agent_prefix??"Support"),
    max_identifiers:Number(group.max_identifiers??20),
    media_enabled:group.media_enabled===undefined?true:Boolean(group.media_enabled),
    retention_days:Number(group.retention_days??30),
    binding_state:String(group.binding_state??(group.enabled?"ACTIVE":"PAUSED")),
    available_rule_sets:rules.map(rule=>({id:rule.id,name:rule.name,version:rule.version,state:rule.enabled?"ACTIVE":"DRAFT",enabled_rule_count:rule.enabled?1:0})),
  };
}
export async function getZammadRoutingCatalog(){
  const fetchedAt=new Date();
  return{instanceId:"fixture-zammad",fetchedAt:fetchedAt.toISOString(),expiresAt:new Date(fetchedAt.getTime()+30_000).toISOString(),groups:[
    {id:"2",name:"Riyadh Operations",active:true,serviceIdentityCanCreate:true},
    {id:"3",name:"Escalations",active:true,serviceIdentityCanCreate:true},
    {id:"4",name:"Linehaul",active:true,serviceIdentityCanCreate:true},
    {id:"5",name:"Priority Support",active:true,serviceIdentityCanCreate:true},
    {id:"6",name:"Returns",active:true,serviceIdentityCanCreate:true},
  ],owners:[
    {id:"19",name:"Sara Khan",login:"sara@northstar.example",active:true,groupIds:["2","3","4","5","6"]},
    {id:"21",name:"Amal Rahman",login:"amal@northstar.example",active:true,groupIds:["2","3","4"]},
  ],slas:[{id:"2",name:"Standard operations",active:true,calendarId:"2"},{id:"3",name:"Priority response",active:true,calendarId:"2"}],calendars:[{id:"2",name:"Riyadh business hours",active:true,timezone:"Asia/Riyadh"}]};
}
export async function saveGroupConfiguration(id:string,input:Record<string,unknown>,actor:string){
  const group=groups.find(row=>row.id===id);
  if(!group)throw new Error("WhatsApp group was not found");
  const rule=rules.find(item=>item.id===input.ruleSetId);
  const connection=connections.find(row=>row.id===group.connection_id);
  const state=String(input.state??"DRAFT");
  const wasActive=group.binding_state==="ACTIVE"||Boolean(group.enabled);
  if(!rule)throw new Error("Group or rule set not found");
  if(state==="ACTIVE"){
    const blockers=[];
    if(connection?.state!=="WORKING")blockers.push("the WhatsApp connection is not working");
    if(!rule.enabled)blockers.push("the selected rule set has no enabled triggers");
    if(blockers.length)throw new Error(`Group cannot be activated: ${blockers.join("; ")}`);
  }
  Object.assign(group,{
    wasalx_name:String(input.displayName??"").trim()||null,
    name:String(input.displayName??group.name).trim()||group.name,
    rule_set_id:String(input.ruleSetId),rule_name:rule.name,
    zammad_group_id:String(input.zammadGroupId),zammad_group:String(input.zammadGroupId),
    default_priority:String(input.defaultPriority??"normal"),assignment_mode:String(input.assignmentMode??"zammad_auto"),
    fixed_owner_id:input.fixedOwnerId||null,sla_policy_id:input.slaPolicyId||null,
    business_hours_mode:String(input.businessHoursMode??"ALWAYS"),business_hours_calendar_id:input.businessHoursCalendarId||null,
    acknowledgement_template:String(input.acknowledgementTemplate??""),agent_prefix:String(input.agentPrefix??""),
    max_identifiers:Number(input.maxIdentifiers??20),media_enabled:Boolean(input.mediaEnabled),
    retention_days:Number(input.retentionDays??30),binding_state:state,enabled:state==="ACTIVE"?1:0,
  });
  if(state==="ACTIVE"||wasActive)markNativeRoutingSyncPending();
  record(actor,"group.binding_updated",String(group.name),`Saved ${state.toLowerCase()} group configuration`);
  return{id:String(group.id),state};
}
export async function getGroupWorkspaceSettings(){return structuredClone(groupWorkspaceSettings)}
export async function updateGroupWorkspaceSettings(input:Record<string,unknown>,actor:string){
  if(Number(input.expectedVersion)!==groupWorkspaceSettings.version)throw Object.assign(new Error("Group workspace settings changed; reload before saving"),{status:409});
  Object.assign(groupWorkspaceSettings,{group_workspace_enabled:Boolean(input.enabled),group_history_default_retention_days:fixtureInteger(input.retentionDays,1,3650,"retentionDays"),group_history_default_visibility:String(input.visibility),version:groupWorkspaceSettings.version+1});
  record(actor,"group_workspace.defaults_updated",tenant.id,"Updated group history defaults");return structuredClone(groupWorkspaceSettings);
}
export async function getWahaOutboundSafety(){return{control:{enabled:true,version:1,reason:"Fixture policy",updated_at:now()},policies:structuredClone(wahaOutboundPolicies)}}
export async function updateWahaOutboundConnectionSafety(connectionId:string,input:Record<string,unknown>,actor:string){
  const policy=wahaOutboundPolicies.find(row=>row.connection_id===connectionId);if(!policy)throw Object.assign(new Error("WhatsApp send policy was not found"),{status:404});
  if(Number(input.expectedVersion)!==policy.version)throw Object.assign(new Error("WhatsApp send policy changed. Refresh and try again."),{status:409});
  Object.assign(policy,{allow_human_group_workspace_initiation:Boolean(input.allowHumanGroupWorkspaceInitiation),version:policy.version+1,reason:String(input.reason),updated_at:now()});record(actor,"waha.outbound.connection_policy_changed",connectionId,"Updated WhatsApp send policy");return structuredClone(policy);
}
export async function getGroupWorkspaceGroup(id:string){
  const group=groups.find(row=>row.id===id);if(!group)throw Object.assign(new Error("WhatsApp group was not found"),{status:404});
  const value=groupWorkspaceGroups.get(id)??{capture_enabled:false,enabled_at:null,retention_days:groupWorkspaceSettings.group_history_default_retention_days,visibility:groupWorkspaceSettings.group_history_default_visibility,agent_prefix:"Agent:",agent_identity_placement:"HEADER",version:0};
  return{...structuredClone(group),...structuredClone(value),group_workspace_enabled:groupWorkspaceSettings.group_workspace_enabled,grants:structuredClone(groupWorkspaceGrants.get(id)??[])};
}
export async function updateGroupWorkspaceGroup(id:string,input:Record<string,unknown>,actor:string){
  if(!groupWorkspaceSettings.group_workspace_enabled)throw Object.assign(new Error("Enable the group workspace before capturing history"),{status:400});
  const current=await getGroupWorkspaceGroup(id) as Record<string,unknown>;if(Number(input.expectedVersion)!==Number(current.version))throw Object.assign(new Error("Group workspace settings changed; reload before saving"),{status:409});
  const captureEnabled=Boolean(input.captureEnabled);const updated={capture_enabled:captureEnabled,enabled_at:captureEnabled&&!current.capture_enabled?now():current.enabled_at,retention_days:fixtureInteger(input.retentionDays,1,3650,"retentionDays"),visibility:String(input.visibility),agent_prefix:String(input.agentPrefix??"Agent:"),agent_identity_placement:String(input.agentIdentityPlacement??"HEADER"),version:Number(current.version)+1};
  groupWorkspaceGroups.set(id,updated);record(actor,"group_workspace.group_updated",id,"Updated group history capture");return structuredClone(updated);
}
export async function grantGroupWorkspaceAccess(id:string,input:Record<string,unknown>,actor:string){
  await getGroupWorkspaceGroup(id);const grants=groupWorkspaceGrants.get(id)??[];const subjectType=String(input.subjectType);const subjectExternalId=String(input.subjectExternalId);const existing=grants.find(grant=>grant.subject_type===subjectType&&grant.subject_external_id===subjectExternalId);if(existing)return{...structuredClone(existing),duplicate:true};
  const created={id:crypto.randomUUID(),subject_type:subjectType,subject_external_id:subjectExternalId};grants.push(created);groupWorkspaceGrants.set(id,grants);record(actor,"group_workspace.access_granted",id,"Granted group history access");return{...structuredClone(created),duplicate:false};
}
export async function revokeGroupWorkspaceAccess(id:string,grantId:string,actor:string){
  const grants=groupWorkspaceGrants.get(id)??[];const index=grants.findIndex(grant=>grant.id===grantId);if(index<0)throw Object.assign(new Error("Group access grant was not found"),{status:404});grants.splice(index,1);groupWorkspaceGrants.set(id,grants);record(actor,"group_workspace.access_revoked",id,"Revoked group history access");return{removed:true};
}

function zammadGroupId(name:string){return new Map([["Riyadh Operations","2"],["Escalations","3"],["Linehaul","4"],["Priority Support","5"],["Returns","6"]]).get(name)}
export async function restartConnection(id:string,actor:string){const item=connections.find(row=>row.id===id);if(item){item.state="CONNECTING";item.action_reason=null;item.last_event_at=now()}record(actor,"connection.restart_requested",id,"Started a safe connection recovery")}
export async function toggleGroup(id:string,enabled:boolean,actor:string){const item=groups.find(row=>row.id===id);if(item){item.enabled=enabled?1:0;markNativeRoutingSyncPending();}record(actor,enabled?"group.activated":"group.paused",id,enabled?"Activated group automation":"Paused group automation")}
export async function retryDelivery(id:string,actor:string){const item=deliveries.find(row=>row.id===id);if(!item)throw Object.assign(new Error("Delivery was not found"),{status:404});const retryable=item.state==="FAILED_RETRYABLE"||(item.state==="FAILED_TERMINAL"&&item.manual_retry_allowed===true);if(!retryable)throw Object.assign(new Error("Delivery is not retryable"),{status:400});item.state="QUEUED";item.attempts=Number(item.attempts)+1;item.error_message=null;item.manual_retry_allowed=false;item.updated_at=now();record(actor,"delivery.retry_requested",id,"Queued delivery for a safe retry")}
export async function getRuleSetVersions(){return structuredClone(ruleSetVersions)}
export async function getRuleSetReadiness(id:string){const snapshot=ruleSetVersions.find(item=>item.id===id);if(!snapshot)throw Object.assign(new Error("Rule-set version was not found"),{status:404});const snapshotRules=Array.isArray(snapshot.rules)?snapshot.rules as Record<string,unknown>[]:[];const enabled=snapshotRules.filter(rule=>rule.enabled!==false);return{ready:enabled.length>0,enabledRuleCount:enabled.length,checkedExamples:enabled.reduce((count,rule)=>count+(Array.isArray(rule.savedExamples)?rule.savedExamples.length:0),0),blockers:enabled.length?[]:[{code:"NO_ENABLED_RULES",message:"At least one rule must be enabled before activation.",ruleIds:[]}],warnings:enabled.filter(rule=>!Array.isArray(rule.savedExamples)||rule.savedExamples.length===0).map(rule=>({code:"NO_SAVED_EXAMPLES",message:`${String(rule.name)} has no saved examples; add positive and negative cases for safer changes.`,ruleIds:[String(rule.id)]}))}}
export async function compareRuleSetVersions(leftId:string,rightId:string){const left=ruleSetVersions.find(item=>item.id===leftId);const right=ruleSetVersions.find(item=>item.id===rightId);if(!left||!right)throw Object.assign(new Error("A rule-set version was not found"),{status:404});if(left.family_id!==right.family_id)throw Object.assign(new Error("Only versions in the same rule family can be compared"),{status:400});const before=new Map((left.rules as Record<string,unknown>[]).map(rule=>[String(rule.name).toLowerCase(),rule]));const after=new Map((right.rules as Record<string,unknown>[]).map(rule=>[String(rule.name).toLowerCase(),rule]));const names=[...new Set([...before.keys(),...after.keys()])].sort();const changes=names.map(name=>{const previous=before.get(name);const next=after.get(name);if(!previous)return{kind:"ADDED",name:next!.name,before:null,after:next,fieldDiffs:[]};if(!next)return{kind:"REMOVED",name:previous.name,before:previous,after:null,fieldDiffs:[]};const fieldDiffs=describeRuleChange({before:previous,after:next});return{kind:fieldDiffs.length?"CHANGED":"UNCHANGED",name:next.name,before:previous,after:next,fieldDiffs}});return{familyId:left.family_id,left:ruleSetIdentity(left),right:ruleSetIdentity(right),summary:{added:changes.filter(change=>change.kind==="ADDED").length,removed:changes.filter(change=>change.kind==="REMOVED").length,changed:changes.filter(change=>change.kind==="CHANGED").length,unchanged:changes.filter(change=>change.kind==="UNCHANGED").length},changes}}
export async function activateRuleSetVersion(id:string,input:Record<string,unknown>,actor:string){const target=ruleSetVersions.find(item=>item.id===id);if(!target||target.state!=="DRAFT")throw Object.assign(new Error("The requested draft is no longer available for activation"),{status:409});if(Number(target.revision)!==Number(input.expectedRevision))throw Object.assign(new Error("Rule-set version changed; refresh before activation"),{status:409});const active=ruleSetVersions.find(item=>item.family_id===target.family_id&&item.state==="ACTIVE");if(String(input.expectedActiveRuleSetId??"")!==String(active?.id??"" )||Number(input.expectedActiveRevision??0)!==Number(active?.revision??0))throw Object.assign(new Error("Active rule-set changed; refresh before continuing"),{status:409});if(active){active.state="RETIRED";active.retired_at=now()}target.state="ACTIVE";target.activated_at=now();syncActiveFixtureRules();record(actor,"rule_set.activated",id,`Activated rule-set version ${String(target.version)}`);return{sourceId:active?.id??null,resultId:id,result:{...ruleSetIdentity(target),retiredRuleSetId:active?.id??null,bindingsMigrated:groups.length,readiness:await getRuleSetReadiness(id)},duplicate:false}}
export async function rollbackRuleSetVersion(id:string,input:Record<string,unknown>,actor:string){const source=ruleSetVersions.find(item=>item.id===id);if(!source||source.state!=="RETIRED")throw Object.assign(new Error("Only a retired version can be used as a rollback source"),{status:409});if(Number(source.revision)!==Number(input.expectedSourceRevision))throw Object.assign(new Error("Rollback source changed; refresh before rollback"),{status:409});const active=ruleSetVersions.find(item=>item.family_id===source.family_id&&item.state==="ACTIVE");if(String(input.expectedActiveRuleSetId??"")!==String(active?.id??"")||Number(input.expectedActiveRevision??0)!==Number(active?.revision??0))throw Object.assign(new Error("Active rule-set changed; refresh before continuing"),{status:409});if(!active)throw Object.assign(new Error("There is no active version to roll back"),{status:409});active.state="RETIRED";active.retired_at=now();const nextVersion=Math.max(...ruleSetVersions.filter(item=>item.family_id===source.family_id).map(item=>Number(item.version)))+1;const created={...structuredClone(source),id:crypto.randomUUID(),version:nextVersion,state:"ACTIVE",revision:1,supersedes_rule_set_id:active.id,rollback_source_rule_set_id:source.id,created_at:now(),activated_at:now(),retired_at:null};ruleSetVersions.push(created);syncActiveFixtureRules();record(actor,"rule_set.rolled_back",String(created.id),`Rolled back from version ${String(source.version)} into version ${nextVersion}`);return{sourceId:id,resultId:created.id,result:{...ruleSetIdentity(created),rollbackSourceRuleSetId:id,rollbackSourceVersion:Number(source.version),retiredRuleSetId:active.id,bindingsMigrated:groups.length,readiness:await getRuleSetReadiness(String(created.id))},duplicate:false}}
export async function createRule(input:Omit<TriggerRule,"id"|"matchCount"|"version">&{savedExamples?:Array<{name:string;message:string;expectedMatches:string[]}>},actor:string){const id=crypto.randomUUID();const familyId=crypto.randomUUID();ruleSetVersions.push({id,family_id:familyId,name:input.name,version:1,state:"DRAFT",revision:1,snapshot_sha256:`fixture-${id}`,supersedes_rule_set_id:null,rollback_source_rule_set_id:null,created_at:now(),activated_at:null,retired_at:null,rules:[{id:crypto.randomUUID(),name:input.name,matcherType:input.matcherType,pattern:input.pattern,matcherOptions:{prefix:input.prefix,digitLength:input.digitLength,...(input.groupCommand?{groupCommand:structuredClone(input.groupCommand)}:{})},priority:input.priority,enabled:input.enabled,savedExamples:structuredClone(input.savedExamples??[])}]});record(actor,"rule_set.created",input.name,"Created governed draft rule-set version 1");return id}
function fixtureCloneFingerprint(value:unknown):string {
  const canonical=(value:unknown):unknown=>value&&typeof value==='object'&&!Array.isArray(value)
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]))
    :Array.isArray(value)?value.map(canonical):value;
  return JSON.stringify(canonical(value));
}
function fixturePolicyCloneRules(sourceRules: Array<Record<string, unknown>>, body: Record<string, unknown>) {
  const invalid = () => Object.assign(new Error('Clone rules must preserve the source rules except for the team sender policy'), {status:400});
  if(Object.keys(body).some(key=>key!== 'rules'))throw invalid();
  if(body.rules===undefined)return structuredClone(sourceRules);
  if(!Array.isArray(body.rules)||body.rules.length!==sourceRules.length)throw invalid();
  const rules=body.rules;
  return sourceRules.map((source,index)=>{
    const input=rules[index];
    if(!input||typeof input!=='object'||Array.isArray(input))throw invalid();
    const supplied=input as Record<string,unknown>;
    if(Object.hasOwn(supplied,"id"))throw invalid();
    const clean=(value:Record<string,unknown>)=>{
      const rule={...value};delete rule.id;
      const options=rule.matcherOptions;
      if(!options||typeof options!=='object'||Array.isArray(options))throw invalid();
      const rest={...(options as Record<string,unknown>)};delete rest.teamSenderPolicy;
      return {...rule,matcherOptions:rest};
    };
    if(fixtureCloneFingerprint(clean(source))!==fixtureCloneFingerprint(clean(supplied)))throw invalid();
    const policy=(supplied.matcherOptions as Record<string,unknown>).teamSenderPolicy;
    if(policy!==undefined&&policy!=='include'&&policy!=='exclude')throw invalid();
    return {...structuredClone(source),id:crypto.randomUUID(),matcherOptions:{...(source.matcherOptions as Record<string,unknown>),teamSenderPolicy:policy??'include'}};
  });
}

const ruleCloneOperations=new Map<string,{fingerprint:string;receipt:{sourceId:string;resultId:string;result:Record<string,unknown>;duplicate:boolean}}>();
export async function cloneRuleSetVersion(id:string,actor:string,key:string,input:Record<string,unknown>={}){
  const fingerprint=fixtureCloneFingerprint({id,input});
  const existing=ruleCloneOperations.get(key);
  if(existing){if(existing.fingerprint!==fingerprint)throw Object.assign(new Error("Operation key belongs to another clone request"),{status:409});return{...structuredClone(existing.receipt),duplicate:true}}
  const source=ruleSetVersions.find(item=>item.id===id);
  if(!source)throw Object.assign(new Error("Source rule-set version was not found"),{status:404});
  const cloneRules=fixturePolicyCloneRules(source.rules as Record<string,unknown>[],input);
  const version=Math.max(...ruleSetVersions.filter(item=>item.family_id===source.family_id).map(item=>Number(item.version)))+1;
  const created={...structuredClone(source),rules:cloneRules,id:crypto.randomUUID(),version,state:"DRAFT",revision:1,supersedes_rule_set_id:source.id,rollback_source_rule_set_id:null,created_at:now(),activated_at:null,retired_at:null};
  ruleSetVersions.push(created);
  const result={sourceId:id,resultId:created.id,result:ruleSetIdentity(created),duplicate:false};
  ruleCloneOperations.set(key,{fingerprint,receipt:structuredClone(result)});record(actor,"rule_set.cloned",String(created.id),`Created draft version ${version}`);
  return result;
}
export async function createConnection(input:{provider:"WAHA"|"META";name:string;engine?:"GOWS"|"NOWEB";disclosureAccepted?:boolean;disclosureVersion?:string},actor:string){
  if(input.provider==="WAHA"&&input.engine!==undefined&&input.engine!=="GOWS")throw Object.assign(new Error("Only the qualified GOWS engine is available for new connections"),{status:400});
  const id=crypto.randomUUID();
  const operationId=crypto.randomUUID();
  const createdAt=now();
  const engine=input.provider==="WAHA"?(input.engine??"GOWS"):"CLOUD_API";
  connections.push({
    id,tenant_id:tenant.id,name:input.name,phone:"",provider:input.provider,engine,
    state:"PROVISIONING",group_count:0,last_event_at:createdAt,action_reason:null,
    provider_session_state:"PROVISIONING",provider_state:"PROVISIONING",webhook_state:"ACTIVE",
    latest_operation_id:operationId,latest_operation_type:"PROVISION",latest_operation_state:"QUEUED",
    latest_operation_attempts:0,latest_operation_safe_error:null,latest_operation_created_at:createdAt,
  });
  record(actor,"connection.created",id,`Created ${input.provider} connection with ${engine}`);
  return{id,state:"PROVISIONING" as const,operation:{id:operationId,type:"PROVISION" as const,state:"QUEUED" as const,attempts:0,createdAt}};
}
export async function acceptWahaEvent(token:string,eventId:string,eventType:string,payload:string){if(token!=="ops-demo")throw new Error("Unknown webhook endpoint");return acceptProviderEvent({tenantId:tenant.id,connectionId:"12000000-0000-4000-8000-000000000001",provider:"WAHA",eventId,eventType,payload})}
export async function acceptProviderEvent(input:{tenantId:string;connectionId:string;provider:"WAHA"|"META";eventId:string;eventType:string;payload:string}){const key=`${input.provider}:${input.connectionId}:${input.eventId}`;const duplicate=providerEvents.has(key);providerEvents.add(key);return{duplicate}}
export async function enqueueZammadOutbound(input:{tenantId:string;connectionId:string;groupId:string;ticketId:string;articleId:string;body:string;contentType:string;replyToMessageId?:string;idempotencyKey:string}){const key=`${input.tenantId}:${input.idempotencyKey}`;const existing=outbox.get(key);if(existing)return{...existing,duplicate:true};const value={id:crypto.randomUUID(),state:"QUEUED",ticketId:input.ticketId,articleId:input.articleId};outbox.set(key,value);return{...value,duplicate:false}}
export async function updateOutboundStatus(input:{tenantId:string;idempotencyKey:string;state:string;externalMessageId?:string;safeError?:string}){const item=outbox.get(`${input.tenantId}:${input.idempotencyKey}`);if(item)item.state=input.state}
export async function retryOutboundByTicket(input:{tenantId:string;ticketId:string;articleId:string}){const item=[...outbox.values()].find(value=>value.ticketId===input.ticketId&&value.articleId===input.articleId);if(!item)throw new Error("Delivery not found");item.state="QUEUED";return{id:item.id,state:"QUEUED" as const}}
function record(actor:string,action:string,target:string,detail:string){audit.unshift({id:crypto.randomUUID(),tenant_id:tenant.id,actor,action,target,detail,request_id:crypto.randomUUID(),created_at:now()})}
function publicDelivery(item:Record<string,unknown>){const copy=structuredClone(item);copy.body_available=typeof copy.message_body==="string"&&copy.message_body.trim().length>0;delete copy.message_body;return copy}
function fixtureInteger(value:unknown,minimum:number,maximum:number,name:string){const number=Number(value);if(!Number.isSafeInteger(number)||number<minimum||number>maximum)throw Object.assign(new Error(`${name} must be an integer between ${minimum} and ${maximum}`),{status:400});return number}
function fixtureConversationCursor(value:string){
  try{
    if(value.length>1024||!/^[-_A-Za-z0-9]+$/u.test(value))throw new Error("invalid encoding");
    const bytes=Buffer.from(value,"base64url");
    if(bytes.toString("base64url")!==value)throw new Error("non-canonical encoding");
    const parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
    if(!parsed||Array.isArray(parsed)||Object.keys(parsed).sort().join(",")!=="at,id,tenant,v"||parsed.v!==1||parsed.tenant!==tenant.id||typeof parsed.at!=="string"||typeof parsed.id!=="string")throw new Error("invalid payload");
    if(!validFixtureConversationTimestamp(parsed.at))throw new Error("invalid boundary");
    return{at:parsed.at,id:parsed.id};
  }catch{throw Object.assign(new Error("Conversation cursor is invalid"),{status:400})}
}
function encodeFixtureConversationCursor(row:Record<string,unknown>){return Buffer.from(JSON.stringify({v:1,tenant:tenant.id,at:String(row.last_activity_at),id:String(row.id)}),"utf8").toString("base64url")}
function fixtureConversationEventCursor(value:string,conversationId:string){
  try{
    if(value.length>1024||!/^[-_A-Za-z0-9]+$/u.test(value))throw new Error("invalid encoding");
    const bytes=Buffer.from(value,"base64url");
    if(bytes.toString("base64url")!==value)throw new Error("non-canonical encoding");
    const parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as Record<string,unknown>;
    if(!parsed||Array.isArray(parsed)||Object.keys(parsed).sort().join(",")!=="at,conversation,id,tenant,v"||parsed.v!==1||parsed.tenant!==tenant.id||parsed.conversation!==conversationId||typeof parsed.at!=="string"||typeof parsed.id!=="string")throw new Error("invalid payload");
    if(!validFixtureConversationTimestamp(parsed.at))throw new Error("invalid boundary");
    return{at:parsed.at,id:parsed.id};
  }catch{throw Object.assign(new Error("Conversation event cursor is invalid"),{status:400})}
}
function encodeFixtureConversationEventCursor(conversationId:string,row:{at:string;id:string}){return Buffer.from(JSON.stringify({v:1,tenant:tenant.id,conversation:conversationId,at:row.at,id:row.id}),"utf8").toString("base64url")}
function validFixtureConversationTimestamp(value:string){
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u.exec(value);
  if(!match)return false;
  const[year,month,day,hour,minute,second,millisecond]=match.slice(1).map(Number) as[number,number,number,number,number,number,number];
  if(year<1)return false;
  const timestamp=new Date(0);timestamp.setUTCFullYear(year,month-1,day);timestamp.setUTCHours(hour,minute,second,millisecond);
  return timestamp.getUTCFullYear()===year&&timestamp.getUTCMonth()===month-1&&timestamp.getUTCDate()===day&&timestamp.getUTCHours()===hour&&timestamp.getUTCMinutes()===minute&&timestamp.getUTCSeconds()===second&&timestamp.getUTCMilliseconds()===millisecond;
}
function fixturePrivacyScope(rawType:unknown,rawValue:unknown,allowGroup:boolean){const type=String(rawType??"").toUpperCase();const allowed=new Set(["TENANT","ZAMMAD_TICKET","REFERENCE","PARTICIPANT","ZAMMAD_USER",...(allowGroup?["GROUP_BINDING"]:[])]);if(!allowed.has(type))throw Object.assign(new Error("Privacy scope type is invalid"),{status:400});const value=type==="TENANT"?tenant.id:String(rawValue??"").trim();if(!value||value.length>512)throw Object.assign(new Error("Privacy scope value is required"),{status:400});if((type==="ZAMMAD_TICKET"||type==="ZAMMAD_USER")&&!/^[1-9]\d{0,18}$/u.test(value))throw Object.assign(new Error(`${type==="ZAMMAD_TICKET"?"Zammad ticket":"Zammad user"} ID is invalid`),{status:400});if(type==="GROUP_BINDING"&&!/^[0-9a-f-]{36}$/iu.test(value))throw Object.assign(new Error("Group binding ID is invalid"),{status:400});return{type,value}}
function ruleSetIdentity(item:Record<string,unknown>){return{id:item.id,familyId:item.family_id,name:item.name,version:Number(item.version),state:item.state,revision:Number(item.revision),snapshotSha256:item.snapshot_sha256,supersedesRuleSetId:item.supersedes_rule_set_id,rollbackSourceRuleSetId:item.rollback_source_rule_set_id,createdAt:item.created_at,activatedAt:item.activated_at,retiredAt:item.retired_at}}
function syncActiveFixtureRules(){const active=ruleSetVersions.filter(snapshot=>snapshot.state==="ACTIVE");rules.splice(0,rules.length,...active.flatMap(snapshot=>{const snapshotRules=Array.isArray(snapshot.rules)?snapshot.rules as Record<string,unknown>[]:[];return snapshotRules.map(rule=>({id:String(rule.id),name:String(rule.name),matcherType:rule.matcherType as TriggerRule["matcherType"],pattern:String(rule.pattern),prefix:typeof (rule.matcherOptions as Record<string,unknown>|undefined)?.prefix==="string"?String((rule.matcherOptions as Record<string,unknown>).prefix):null,digitLength:Number((rule.matcherOptions as Record<string,unknown>|undefined)?.digitLength??0)||null,groupCommand:(rule.matcherOptions as Record<string,unknown>|undefined)?.groupCommand as TriggerRule["groupCommand"]|undefined,priority:Number(rule.priority),enabled:Boolean(rule.enabled),matchCount:0,version:Number(snapshot.version)}))}))}
