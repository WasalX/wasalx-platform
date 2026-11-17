import type { TriggerRule } from "./domain";
import type { BotConversationPageQuery } from "./bot-conversations";
import { portalDataBackend, sitesPrivateDemoError } from "./backend";

const backend = portalDataBackend();
const fixtureMode = backend === "fixture";
const controlPlaneMode = backend === "control-plane";
const runtimeEnv = backend === "d1" ? (await import("cloudflare:workers")).env : undefined;
const fixture = () => import("./fixture-data");
const controlPlane = () => import("./control-plane-data");

export async function getNativeRoutingSync():Promise<import("../packages/core/src/native-routing-contract").NativeRoutingSyncStatus>{
  if(fixtureMode)return(await fixture()).getNativeRoutingSync();
  if(controlPlaneMode)return(await controlPlane()).getNativeRoutingSync();
  throw sitesPrivateDemoError("Native routing synchronization");
}
export async function updateNativeRoutingSync(input:unknown,idempotencyKey:string):Promise<import("../packages/core/src/native-routing-contract").NativeRoutingSyncStatus>{
  const command=(await import("../packages/core/src/native-routing-contract")).parseNativeRoutingSyncCommand(input);
  if(fixtureMode)return(await fixture()).updateNativeRoutingSync(command,idempotencyKey);
  if(controlPlaneMode)return(await controlPlane()).requestNativeRoutingSync(command,idempotencyKey);
  throw sitesPrivateDemoError("Native routing synchronization");
}

const TENANT_ID = "tenant_northstar";

type RuleCreateInput = Omit<TriggerRule,"id"|"matchCount"|"version"> & {
  savedExamples?: Array<{ name:string; message:string; expectedMatches:string[]; sender?: "team" | "customer" | "unknown" }>;
};

const schema = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL, accent TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    phone TEXT NOT NULL, provider TEXT NOT NULL, engine TEXT,
    state TEXT NOT NULL, group_count INTEGER NOT NULL DEFAULT 0,
    last_event_at TEXT, action_reason TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_groups (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    name TEXT NOT NULL, external_group_id TEXT NOT NULL,
    zammad_group TEXT NOT NULL, rule_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, members INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT, UNIQUE(connection_id, external_group_id)
  )`,
  `CREATE TABLE IF NOT EXISTS trigger_rules (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    matcher_type TEXT NOT NULL, pattern TEXT NOT NULL, prefix TEXT,
    digit_length INTEGER, priority INTEGER NOT NULL, enabled INTEGER NOT NULL,
    match_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, ticket_number TEXT NOT NULL,
    group_name TEXT NOT NULL, excerpt TEXT NOT NULL, state TEXT NOT NULL,
    provider TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL,
    request_id TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_inbox (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    provider TEXT NOT NULL, provider_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
    received_at TEXT NOT NULL, UNIQUE(provider, connection_id, provider_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS case_correlations (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, group_binding_id TEXT NOT NULL,
    normalized_reference TEXT NOT NULL, zammad_ticket_id TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(tenant_id, group_binding_id, normalized_reference)
  )`,
  `CREATE TABLE IF NOT EXISTS tenant_memberships (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
    email TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(tenant_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS provider_sessions (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    opaque_session_id TEXT NOT NULL, worker_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT, state TEXT NOT NULL, secret_reference TEXT,
    UNIQUE(connection_id, opaque_session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS message_links (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    external_message_id TEXT NOT NULL, zammad_ticket_id TEXT NOT NULL,
    direction TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(connection_id, external_message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL, state TEXT NOT NULL, provider_code TEXT,
    safe_error TEXT, started_at TEXT NOT NULL, finished_at TEXT,
    UNIQUE(delivery_id, attempt_number)
  )`,
  `CREATE TABLE IF NOT EXISTS media_objects (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, sha256 TEXT NOT NULL,
    object_key TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
    scan_state TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(tenant_id, sha256)
  )`,
  `CREATE TABLE IF NOT EXISTS consent_records (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    policy_type TEXT NOT NULL, policy_version TEXT NOT NULL,
    accepted_at TEXT NOT NULL, UNIQUE(tenant_id, actor_id, policy_type, policy_version)
  )`,
  `CREATE TABLE IF NOT EXISTS provisioning_operations (
    tenant_id TEXT PRIMARY KEY, status TEXT NOT NULL, current_step TEXT,
    completed_steps TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0,
    error_code TEXT, error_detail TEXT, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS delivery_outbox (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    group_id TEXT NOT NULL, zammad_ticket_id TEXT NOT NULL, zammad_article_id TEXT NOT NULL,
    message_body TEXT NOT NULL, content_type TEXT NOT NULL, reply_to_message_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    external_message_id TEXT, last_error TEXT, available_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
];

let initialized: Promise<void> | null = null;

function d1() {
  if (!runtimeEnv?.DB) throw new Error("D1 binding DB is unavailable. Set PORTAL_DATA_BACKEND=fixture only for an isolated container preview.");
  return runtimeEnv.DB;
}

async function initialize() {
  if (initialized) return initialized;
  initialized = (async () => {
    const db = d1();
    await db.batch(schema.map((sql) => db.prepare(sql)));
    const existing = await db.prepare("SELECT id FROM tenants WHERE id = ?").bind(TENANT_ID).first();
    if (existing) return;

    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO tenants (id,name,slug,plan,accent,created_at) VALUES (?,?,?,?,?,?)").bind(TENANT_ID,"Northstar Logistics","northstar","Pilot","#5B5BD6",now),
      db.prepare("INSERT INTO connections (id,tenant_id,name,phone,provider,engine,state,group_count,last_event_at,action_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind("12000000-0000-4000-8000-000000000001",TENANT_ID,"Operations line","12025550100","WAHA","GOWS","WORKING",4,new Date(Date.now()-120000).toISOString(),null,now),
      db.prepare("INSERT INTO connections (id,tenant_id,name,phone,provider,engine,state,group_count,last_event_at,action_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind("12000000-0000-4000-8000-000000000002",TENANT_ID,"Returns desk","12025550101","WAHA","NOWEB","ACTION_REQUIRED",2,new Date(Date.now()-7200000).toISOString(),"Linked device authorization expired",now),
      ...[
        ["grp_riyadh","12000000-0000-4000-8000-000000000001","Riyadh · Last mile","120363118@g.us","Riyadh Operations","Ten-digit shipment ID",1,38,4],
        ["grp_jeddah","12000000-0000-4000-8000-000000000001","Jeddah · Escalations","120363204@g.us","Escalations","ABC reference",1,22,11],
        ["grp_dammam","12000000-0000-4000-8000-000000000001","Dammam · Linehaul","120363338@g.us","Linehaul","Ten-digit shipment ID",1,17,26],
        ["grp_vip","12000000-0000-4000-8000-000000000001","VIP customers","120363401@g.us","Priority Support","VIP prefix",0,12,50],
        ["grp_returns","12000000-0000-4000-8000-000000000002","Returns approvals","120363512@g.us","Returns","ABC reference",1,29,121],
      ].map((g) => db.prepare("INSERT INTO whatsapp_groups (id,tenant_id,connection_id,name,external_group_id,zammad_group,rule_name,enabled,members,last_message_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(g[0],TENANT_ID,g[1],g[2],g[3],g[4],g[5],g[6],g[7],new Date(Date.now()-Number(g[8])*60000).toISOString())),
      db.prepare("INSERT INTO trigger_rules (id,tenant_id,name,matcher_type,pattern,prefix,digit_length,priority,enabled,match_count,version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind("rule_digits",TENANT_ID,"Ten-digit shipment ID","exact_length","(?<!\\d)\\d{10}(?!\\d)",null,10,1,1,1842,3,now),
      db.prepare("INSERT INTO trigger_rules (id,tenant_id,name,matcher_type,pattern,prefix,digit_length,priority,enabled,match_count,version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind("rule_abc",TENANT_ID,"ABC reference","prefix_length","\\bABC\\d{7}\\b","ABC",7,2,1,626,2,now),
      db.prepare("INSERT INTO trigger_rules (id,tenant_id,name,matcher_type,pattern,prefix,digit_length,priority,enabled,match_count,version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind("rule_vip",TENANT_ID,"VIP prefix","starts_with","VIP-",null,null,3,0,51,1,now),
      ...[
        ["16000000-0000-4000-8000-000000000001","#10382","Riyadh · Last mile","Driver has been reassigned. ETA 18 minutes.","DELIVERED","WAHA",1,null,2],
        ["16000000-0000-4000-8000-000000000002","#10381","Jeddah · Escalations","We are checking the POD with the hub.","SENT","WAHA",1,null,6],
        ["16000000-0000-4000-8000-000000000003","#10380","Returns approvals","Return approved. Please use label RT-2391.","FAILED_RETRYABLE","WAHA",2,"Session needs reauthorization",13],
        ["16000000-0000-4000-8000-000000000004","#10377","Dammam · Linehaul","Linehaul departed at 14:20.","DELIVERED","WAHA",1,null,34],
        ["16000000-0000-4000-8000-000000000005","#10375","Riyadh · Last mile","Case assigned to Ahmed from dispatch.","READ","WAHA",1,null,51],
      ].map((x) => { const t=new Date(Date.now()-Number(x[8])*60000).toISOString(); return db.prepare("INSERT INTO deliveries (id,tenant_id,ticket_number,group_name,excerpt,state,provider,attempts,error_message,created_at,updated_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(x[0],TENANT_ID,x[1],x[2],x[3],x[4],x[5],x[6],x[7],t,t,`idem_${x[0]}`)}),
      ...[
        ["aud_1","Maya Al-Salem","connection.reauth_requested","Returns desk","Restarted secure authentication flow",4],
        ["aud_2","WasalX system","delivery.retry_scheduled","#10380","Retry 3 scheduled with exponential backoff",12],
        ["aud_3","Omar Haddad","group.binding_updated","Jeddah · Escalations","Mapped to Zammad group Escalations",43],
        ["aud_4","Maya Al-Salem","rule.activated","ABC reference","Activated rule version 2",91],
      ].map((x) => db.prepare("INSERT INTO audit_events (id,tenant_id,actor,action,target,detail,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(x[0],TENANT_ID,x[1],x[2],x[3],x[4],`req_${x[0]}`,new Date(Date.now()-Number(x[5])*60000).toISOString())),
    ]);
  })();
  return initialized;
}

async function all<T>(sql: string, ...values: unknown[]): Promise<T[]> {
  await initialize();
  const result = await d1().prepare(sql).bind(...values).all<T>();
  return result.results ?? [];
}

export async function getDashboardData() {
  if (fixtureMode) return (await fixture()).getDashboardData();
  if (controlPlaneMode) return (await controlPlane()).getDashboardData();
  const [tenant, connections, groups, ruleRows, deliveries, audit] = await Promise.all([
    all<Record<string, unknown>>("SELECT * FROM tenants WHERE id = ?", TENANT_ID),
    all<Record<string, unknown>>("SELECT * FROM connections WHERE tenant_id = ? ORDER BY created_at", TENANT_ID),
    all<Record<string, unknown>>("SELECT * FROM whatsapp_groups WHERE tenant_id = ? ORDER BY enabled DESC, name", TENANT_ID),
    all<Record<string, unknown>>("SELECT * FROM trigger_rules WHERE tenant_id = ? ORDER BY priority", TENANT_ID),
    all<Record<string, unknown>>("SELECT * FROM deliveries WHERE tenant_id = ? ORDER BY updated_at DESC", TENANT_ID),
    all<Record<string, unknown>>("SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC", TENANT_ID),
  ]);

  const rules: TriggerRule[] = ruleRows.map((row) => ({
    id: String(row.id), name: String(row.name), matcherType: row.matcher_type as TriggerRule["matcherType"],
    pattern: String(row.pattern), prefix: row.prefix ? String(row.prefix) : null,
    digitLength: row.digit_length == null ? null : Number(row.digit_length), priority: Number(row.priority),
    enabled: Boolean(row.enabled), matchCount: Number(row.match_count), version: Number(row.version),
  }));

  return {
    tenant: { ...tenant[0], role: "tenant_owner", runtime: "D1", default_theme: "SYSTEM" },
    connections,
    groups,
    rules,
    deliveries: deliveries.map((row) => ({
      ...row,
      excerpt: "Message content redacted",
      body_available: true,
    })),
    audit,
  };
}

export async function restartConnection(id: string, actor: string, idempotencyKey?:string) {
  if (fixtureMode) return (await fixture()).restartConnection(id,actor);
  if (controlPlaneMode) return (await controlPlane()).restartConnection(id,actor,idempotencyKey);
  throw sitesPrivateDemoError("Connection recovery");
}

export async function toggleGroup(id: string, enabled: boolean, actor: string, expectedRevision=0,idempotencyKey="") {
  if (fixtureMode) return (await fixture()).toggleGroup(id,enabled,actor);
  if (controlPlaneMode) return (await controlPlane()).toggleGroup(id,enabled,actor,expectedRevision,idempotencyKey);
  await initialize();
  const now = new Date().toISOString();
  await d1().batch([
    d1().prepare("UPDATE whatsapp_groups SET enabled = ? WHERE id = ? AND tenant_id = ?").bind(enabled ? 1 : 0,id,TENANT_ID),
    d1().prepare("INSERT INTO audit_events (id,tenant_id,actor,action,target,detail,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),TENANT_ID,actor,enabled?"group.activated":"group.paused",id,enabled?"Activated group automation":"Paused group automation",crypto.randomUUID(),now),
  ]);
}

export async function getGroupConfiguration(id: string) {
  if (fixtureMode) return (await fixture()).getGroupConfiguration(id);
  if (controlPlaneMode) return (await controlPlane()).getGroupDetail(id);
  const data = await getDashboardData();
  const group = (data.groups as Record<string, unknown>[]).find((row) => String(row.id) === id);
  if (!group) throw new Error("WhatsApp group was not found");
  const connection = (data.connections as Record<string, unknown>[]).find((row) => row.id === group.connection_id);
  const rule = data.rules.find((row) => row.name === group.rule_name);
  return {
    ...group,
    display_name: group.name,
    provider_display_name: group.name,
    wasalx_name: group.name,
    provider: connection?.provider ?? "WAHA",
    phone_e164: connection?.phone || null,
    connection_state: connection?.state ?? "FAILED",
    zammad_state: "WORKING",
    working_session_count: connection?.state === "WORKING" ? 1 : 0,
    rule_set_id: rule?.id ?? "",
    zammad_group_id: staticZammadGroupId(String(group.zammad_group ?? "")) ?? group.zammad_group,
    default_priority: "normal",
    assignment_mode: "zammad_auto",
    fixed_owner_id: null,
    sla_policy_id: null,
    business_hours_mode: "ALWAYS",
    business_hours_calendar_id: null,
    acknowledgement_template: "Case {{tickets}} is now being tracked by WasalX.",
    agent_prefix: "Support",
    max_identifiers: 20,
    media_enabled: true,
    retention_days: 30,
    binding_state: group.enabled ? "ACTIVE" : "PAUSED",
    available_rule_sets: data.rules.map((item) => ({
      id: item.id,
      name: item.name,
      version: item.version,
      state: item.enabled ? "ACTIVE" : "DRAFT",
      enabled_rule_count: item.enabled ? 1 : 0,
    })),
  };
}

export async function saveGroupConfiguration(id: string, input: Record<string, unknown>, actor: string,idempotencyKey="") {
  if (fixtureMode) return (await fixture()).saveGroupConfiguration(id, input, actor);
  if (controlPlaneMode) return (await controlPlane()).saveGroupBinding(id, input,idempotencyKey);
  await initialize();
  const state = String(input.state ?? "DRAFT");
  const rule = await d1().prepare("SELECT name, enabled FROM trigger_rules WHERE id = ? AND tenant_id = ?").bind(input.ruleSetId, TENANT_ID).first<{name:string;enabled:number}>();
  if (!rule) throw new Error("Group or rule set not found");
  if (state === "ACTIVE" && !rule.enabled) throw new Error("Group cannot be activated: the selected rule set has no enabled triggers");
  const name = String(input.displayName ?? "").trim();
  const zammadGroup = String(input.zammadGroupId ?? "").trim();
  if (!name || !zammadGroup) throw new Error("WasalX name and Zammad group are required");
  await d1().prepare("UPDATE whatsapp_groups SET name = ?, zammad_group = ?, rule_name = ?, enabled = ? WHERE id = ? AND tenant_id = ?").bind(name,zammadGroup,rule.name,state==="ACTIVE"?1:0,id,TENANT_ID).run();
  const now = new Date().toISOString();
  await d1().prepare("INSERT INTO audit_events (id,tenant_id,actor,action,target,detail,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),TENANT_ID,actor,"group.binding_updated",id,`Saved ${state.toLowerCase()} group configuration`,crypto.randomUUID(),now).run();
  return { id, state };
}

export async function getGroupWorkspaceSettings(){
  if(fixtureMode)return(await fixture()).getGroupWorkspaceSettings();
  if(controlPlaneMode)return(await controlPlane()).getGroupWorkspaceSettings();
  throw sitesPrivateDemoError("Group history settings");
}
export async function updateGroupWorkspaceSettings(input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).updateGroupWorkspaceSettings(input,actor);
  if(controlPlaneMode)return(await controlPlane()).updateGroupWorkspaceSettings(input,idempotencyKey);
  throw sitesPrivateDemoError("Group history settings");
}
export async function getWahaOutboundSafety(){
  if(fixtureMode)return(await fixture()).getWahaOutboundSafety();
  if(controlPlaneMode)return(await controlPlane()).getWahaOutboundSafety();
  throw sitesPrivateDemoError("WhatsApp send policy");
}
export async function updateWahaOutboundConnectionSafety(connectionId:string,input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).updateWahaOutboundConnectionSafety(connectionId,input,actor);
  if(controlPlaneMode)return(await controlPlane()).updateWahaOutboundConnectionSafety(connectionId,input,idempotencyKey);
  throw sitesPrivateDemoError("WhatsApp send policy");
}
export async function getGroupWorkspaceGroup(id:string){
  if(fixtureMode)return(await fixture()).getGroupWorkspaceGroup(id);
  if(controlPlaneMode)return(await controlPlane()).getGroupWorkspaceGroup(id);
  throw sitesPrivateDemoError("Group history settings");
}
export async function updateGroupWorkspaceGroup(id:string,input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).updateGroupWorkspaceGroup(id,input,actor);
  if(controlPlaneMode)return(await controlPlane()).updateGroupWorkspaceGroup(id,input,idempotencyKey);
  throw sitesPrivateDemoError("Group history settings");
}
export async function grantGroupWorkspaceAccess(id:string,input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).grantGroupWorkspaceAccess(id,input,actor);
  if(controlPlaneMode)return(await controlPlane()).grantGroupWorkspaceAccess(id,input,idempotencyKey);
  throw sitesPrivateDemoError("Group history access");
}
export async function revokeGroupWorkspaceAccess(id:string,grantId:string,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).revokeGroupWorkspaceAccess(id,grantId,actor);
  if(controlPlaneMode)return(await controlPlane()).revokeGroupWorkspaceAccess(id,grantId,idempotencyKey);
  throw sitesPrivateDemoError("Group history access");
}

export async function getZammadRoutingCatalog() {
  if (fixtureMode) return (await fixture()).getZammadRoutingCatalog();
  if (controlPlaneMode) return (await controlPlane()).getZammadRoutingCatalog();
  return staticZammadRoutingCatalog();
}

export async function stopRetryingDelivery(id:string,body:unknown,idempotencyKey:string) {
  if(controlPlaneMode)return (await controlPlane()).stopRetryingDelivery(id,body,idempotencyKey);
  throw Object.assign(new Error("Delivery recovery requires the control plane"),{status:503});
}

export async function retryDelivery(id: string, actor: string, confirmOutcomeUnknown = false,idempotencyKey="") {
  if (fixtureMode) return (await fixture()).retryDelivery(id,actor);
  if (controlPlaneMode) return (await controlPlane()).retryDelivery(id,actor,confirmOutcomeUnknown,idempotencyKey);
  await initialize();
  const now = new Date().toISOString();
  await d1().batch([
    d1().prepare("UPDATE deliveries SET state = 'QUEUED', attempts = attempts + 1, error_message = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?").bind(now,id,TENANT_ID),
    d1().prepare("INSERT INTO audit_events (id,tenant_id,actor,action,target,detail,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),TENANT_ID,actor,"delivery.retry_requested",id,"Queued delivery for a safe retry",crypto.randomUUID(),now),
  ]);
}

export async function getDeliveryDetail(id:string){
  if(fixtureMode)return(await fixture()).getDeliveryDetail(id);
  if(controlPlaneMode)return(await controlPlane()).getDeliveryDetail(id);
  throw new Error("Delivery receipt timelines require the production control plane");
}

export async function getDeliveryAgentDestination(id:string){
  if(controlPlaneMode)return(await controlPlane()).getDeliveryAgentDestination(id);
  throw Object.assign(new Error("The support case workspace is unavailable"),{status:503});
}

export async function revealDeliveryContent(id:string,actor:string){
  if(fixtureMode)return(await fixture()).revealDeliveryContent(id,actor);
  if(controlPlaneMode)return(await controlPlane()).revealDeliveryContent(id);
  await initialize();
  const row=await d1().prepare("SELECT ticket_number,excerpt FROM deliveries WHERE id = ? AND tenant_id = ?").bind(id,TENANT_ID).first<{ticket_number:string;excerpt:string}>();
  if(!row)throw Object.assign(new Error("Delivery was not found"),{status:404});
  const timestamp=new Date().toISOString();
  await d1().prepare("INSERT INTO audit_events (id,tenant_id,actor,action,target,detail,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),TENANT_ID,actor,"delivery.content_revealed",row.ticket_number,"Revealed one outbound message for an authorized operational review",crypto.randomUUID(),timestamp).run();
  return{body:row.excerpt,revealed_at:timestamp,expires_in_seconds:60};
}

export async function getCases(input:{before?:string;limit?:number;ticket?:string}={}){
  if(fixtureMode)return(await fixture()).getCases(input);
  if(controlPlaneMode)return(await controlPlane()).getCases(input);
  throw Object.assign(new Error("Case lifecycle administration requires the production control plane or fixture preview"),{status:503});
}

export async function getCaseAgentDestination(id:string){
  if(controlPlaneMode)return(await controlPlane()).getCaseAgentDestination(id);
  throw Object.assign(new Error("The support case workspace is unavailable"),{status:503});
}

export async function getGroups(input:{after?:string;limit?:number;query?:string;connectionId?:string}={}){
  if(fixtureMode){const rows=(await fixture()).getDashboardData().then(data=>data.groups);const query=input.query?.trim().toLocaleLowerCase();const groups=(await rows).filter(row=>(!query||`${row.name} ${row.zammad_group} ${row.rule_name}`.toLocaleLowerCase().includes(query))&&(!input.connectionId||String(row.connection_id)===input.connectionId));const start=input.after?groups.findIndex(row=>String(row.id)===input.after)+1:0;return groups.slice(Math.max(0,start),Math.max(0,start)+(input.limit??200));}
  if(controlPlaneMode)return(await controlPlane()).getGroups(input);
  throw Object.assign(new Error("Group administration requires the production control plane or fixture preview"),{status:503});
}

export async function detachCase(id:string,expectedVersion:number,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).detachCase(id,expectedVersion,actor,idempotencyKey);
  if(controlPlaneMode)return(await controlPlane()).detachCase(id,expectedVersion,idempotencyKey);
  throw Object.assign(new Error("Case lifecycle administration requires the production control plane or fixture preview"),{status:503});
}

export async function getReviewItems(state?:string){
  if(fixtureMode)return(await fixture()).getReviewItems(state);
  if(controlPlaneMode)return(await controlPlane()).getReviewItems(state);
  throw new Error("Operator review requires the production control plane");
}

export async function getReviewItem(id:string){
  if(fixtureMode)return(await fixture()).getReviewItem(id);
  if(controlPlaneMode)return(await controlPlane()).getReviewItem(id);
  throw new Error("Operator review requires the production control plane");
}

export async function reviewAction(id:string,action:"resolve"|"discard"|"reprocess",input:Record<string,unknown>,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).reviewAction(id,action,input);
  if(controlPlaneMode)return(await controlPlane()).reviewAction(id,action,input,idempotencyKey);
  throw new Error("Operator review requires the production control plane");
}

export async function createRule(input: RuleCreateInput, actor: string, idempotencyKey: string) {
  if (fixtureMode) return (await fixture()).createRule(input,actor);
  if (controlPlaneMode) return (await controlPlane()).createRule(input,actor,idempotencyKey);
  await initialize();
  const id = `rule_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await d1().batch([
    d1().prepare("INSERT INTO trigger_rules (id,tenant_id,name,matcher_type,pattern,prefix,digit_length,priority,enabled,match_count,version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,TENANT_ID,input.name,input.matcherType,input.pattern,input.prefix,input.digitLength,input.priority,input.enabled?1:0,0,1,now),
    d1().prepare("INSERT INTO audit_events (id,tenant_id,actor,action,target,detail,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),TENANT_ID,actor,"rule.created",input.name,"Created rule version 1",crypto.randomUUID(),now),
  ]);
  return id;
}

export async function getRuleSetVersions(input:{before?:string;limit?:number;state?:string}={}){
  if(fixtureMode)return(await fixture()).getRuleSetVersions();
  if(controlPlaneMode)return(await controlPlane()).getRuleSetVersions(input);
  const data=await getDashboardData();
  return[{id:"d1-active-projection",family_id:"d1-operational-references",name:"Operational references",version:Math.max(1,...data.rules.map(rule=>rule.version)),state:"ACTIVE",revision:1,rules:data.rules}];
}

export async function getTicketEventConfiguration(){if(controlPlaneMode)return(await controlPlane()).getTicketEventConfiguration();throw sitesPrivateDemoError("Ticket event configuration")}
export async function bindTicketEvent(input:Record<string,unknown>,idempotencyKey:string){if(controlPlaneMode)return(await controlPlane()).bindTicketEvent(input,idempotencyKey);throw sitesPrivateDemoError("Ticket event configuration")}
export async function getBotFlows(){if(fixtureMode)return(await fixture()).getBotFlows();if(controlPlaneMode)return(await controlPlane()).getBotFlows();throw sitesPrivateDemoError("Bot flow management")}
export async function getBotFlowCatalog(query=""){if(controlPlaneMode)return(await controlPlane()).getBotFlowCatalog(query);if(fixtureMode){const rows=await(await fixture()).getBotFlows();return{items:rows.map(item=>{const row={...item};delete row.definition;return row}),next_cursor:null}}throw sitesPrivateDemoError("Bot flow management")}
export async function getBotFlow(id:string){if(controlPlaneMode)return(await controlPlane()).getBotFlow(id);if(fixtureMode){const row=(await(await fixture()).getBotFlows()).find(item=>String(item.flow_version_id)===id);if(row)return row;throw new Error("Bot flow version was not found")}throw sitesPrivateDemoError("Bot flow management")}
export async function getBotMediaAssets(ids:string[]=[]){if(fixtureMode)return[];if(controlPlaneMode)return(await controlPlane()).getBotMediaAssets(ids);throw sitesPrivateDemoError("Bot media management")}
export async function createBotMediaAsset(input:{filename:string;mimeType:string;byteSize:number;contentSha256:string},idempotencyKey:string){if(controlPlaneMode)return(await controlPlane()).createBotMediaAsset(input,idempotencyKey);throw sitesPrivateDemoError("Bot media management")}
export async function getBotActions(){if(fixtureMode)return(await fixture()).getBotActions();if(controlPlaneMode)return(await controlPlane()).getBotActions();throw sitesPrivateDemoError("Bot action management")}
export async function getBotActionCatalog(query=""){if(controlPlaneMode)return(await controlPlane()).getBotActionCatalog(query);if(fixtureMode){const rows=await(await fixture()).getBotActions() as Array<Record<string,unknown>>;return{items:rows.map(item=>{const row={...item};for(const key of ["endpoint_url","secret_reference","headers","response_mapping"])delete row[key];return row}),next_cursor:null}}throw sitesPrivateDemoError("Bot action management")}
export async function getBotAction(actionKey:string){if(controlPlaneMode)return(await controlPlane()).getBotAction(actionKey);if(fixtureMode){const row=(await(await fixture()).getBotActions() as Array<Record<string,unknown>>).find(item=>String(item.action_key)===actionKey);if(row)return row;throw new Error("Bot action was not found")}throw sitesPrivateDemoError("Bot action management")}
export async function storeBotActionCredential(input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).storeBotActionCredential(input);if(controlPlaneMode)return(await controlPlane()).storeBotActionCredential(input,idempotencyKey);throw sitesPrivateDemoError("Bot action credential management")}
export async function getBotAssignments(){if(fixtureMode)return(await fixture()).getBotAssignments();if(controlPlaneMode)return(await controlPlane()).getBotAssignments();throw sitesPrivateDemoError("Bot assignment management")}
export async function getBotConversations(input:BotConversationPageQuery={}){if(fixtureMode)return(await fixture()).getBotConversations(input);if(controlPlaneMode)return(await controlPlane()).getBotConversations(input);throw sitesPrivateDemoError("Bot conversation management")}
export async function getBotConversationEvents(conversationId:string,input:BotConversationPageQuery={}){if(fixtureMode)return(await fixture()).getBotConversationEvents(conversationId,input);if(controlPlaneMode)return(await controlPlane()).getBotConversationEvents(conversationId,input);throw sitesPrivateDemoError("Bot conversation history")}
export async function saveBotAction(input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).saveBotAction(input);if(controlPlaneMode)return(await controlPlane()).saveBotAction(input,idempotencyKey);throw sitesPrivateDemoError("Bot action management")}
export async function getBotActionRevisions(actionKey:string){if(fixtureMode)return(await fixture()).getBotActionRevisions(actionKey);if(controlPlaneMode)return(await controlPlane()).getBotActionRevisions(actionKey);throw sitesPrivateDemoError("Bot action revision history")}
export async function restoreBotActionRevision(actionKey:string,revision:number,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).restoreBotActionRevision(actionKey,revision,input);if(controlPlaneMode)return(await controlPlane()).restoreBotActionRevision(actionKey,revision,input,idempotencyKey);throw sitesPrivateDemoError("Bot action revision restore")}
export async function qualifyBotAction(actionKey:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).qualifyBotAction(actionKey,input);if(controlPlaneMode)return(await controlPlane()).qualifyBotAction(actionKey,input,idempotencyKey);throw sitesPrivateDemoError("Bot action qualification")}
export async function getBotActionQualification(actionKey:string,id:string){if(fixtureMode)return(await fixture()).getBotActionQualification(actionKey,id);if(controlPlaneMode)return(await controlPlane()).getBotActionQualification(actionKey,id);throw sitesPrivateDemoError("Bot action qualification")}
export async function createBotFlow(input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).createBotFlow(input);if(controlPlaneMode)return(await controlPlane()).createBotFlow(input,idempotencyKey);throw sitesPrivateDemoError("Bot flow management")}
export async function cloneBotFlow(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).cloneBotFlow(id,input);if(controlPlaneMode)return(await controlPlane()).cloneBotFlow(id,input,idempotencyKey);throw sitesPrivateDemoError("Bot flow management")}
export async function activateBotFlow(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).activateBotFlow(id,input);if(controlPlaneMode)return(await controlPlane()).activateBotFlow(id,input,idempotencyKey);throw sitesPrivateDemoError("Bot flow management")}
export async function assignBotFlow(input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).assignBotFlow(input);if(controlPlaneMode)return(await controlPlane()).assignBotFlow(input,idempotencyKey);throw sitesPrivateDemoError("Bot assignment management")}
export async function setBotAssignmentState(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).setBotAssignmentState(id,input);if(controlPlaneMode)return(await controlPlane()).setBotAssignmentState(id,input,idempotencyKey);throw sitesPrivateDemoError("Bot assignment management")}
export async function setBotAssignmentAttribution(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).setBotAssignmentAttribution(id,input);if(controlPlaneMode)return(await controlPlane()).setBotAssignmentAttribution(id,input,idempotencyKey);throw sitesPrivateDemoError("Bot assignment management")}
export async function commandBotConversation(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).commandBotConversation(id,input);if(controlPlaneMode)return(await controlPlane()).commandBotConversation(id,input,idempotencyKey);throw sitesPrivateDemoError("Bot conversation management")}
export async function getClientRouting(){if(fixtureMode)return(await fixture()).getClientRouting();if(controlPlaneMode)return(await controlPlane()).getClientRouting();throw sitesPrivateDemoError("Client routing")}
export async function getClientRoutingCatalog(query=""){if(controlPlaneMode)return(await controlPlane()).getClientRoutingCatalog(query);if(fixtureMode){const rows=await(await fixture()).getClientRouting();return{items:rows.map(item=>{const row={...item};delete row.definition;return row}),next_cursor:null}}throw sitesPrivateDemoError("Client routing")}
export async function getClientRoutingVersion(id:string){if(controlPlaneMode)return(await controlPlane()).getClientRoutingVersion(id);if(fixtureMode){const row=(await(await fixture()).getClientRouting()).find(item=>String(item.id)===id);if(row)return row;throw new Error("Client routing version was not found")}throw sitesPrivateDemoError("Client routing")}
export async function getClientRoutingCapabilities(){if(fixtureMode)return(await fixture()).getClientRoutingCapabilities();if(controlPlaneMode)return(await controlPlane()).getClientRoutingCapabilities();throw sitesPrivateDemoError("Client routing capabilities")}
export async function getClientRoutingSources(){if(fixtureMode)return(await fixture()).getClientRoutingSources();if(controlPlaneMode)return(await controlPlane()).getClientRoutingSources();throw sitesPrivateDemoError("Client routing source status")}
export async function getClientRoutingIntegrations(){if(fixtureMode)return(await fixture()).getClientRoutingIntegrations();if(controlPlaneMode)return(await controlPlane()).getClientRoutingIntegrations();throw sitesPrivateDemoError("Client routing integrations")}
export async function storeClientRoutingCredential(input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).storeClientRoutingCredential(input);if(controlPlaneMode)return(await controlPlane()).storeClientRoutingCredential(input,idempotencyKey);throw sitesPrivateDemoError("Client routing credential")}
export async function testClientRoutingCredential(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).testClientRoutingCredential(id,input);if(controlPlaneMode)return(await controlPlane()).testClientRoutingCredential(id,input,idempotencyKey);throw sitesPrivateDemoError("Client routing credential test")}
export async function getClientRoutingQualifications(versionId:string){if(fixtureMode)return(await fixture()).getClientRoutingQualifications(versionId);if(controlPlaneMode)return(await controlPlane()).getClientRoutingQualifications(versionId);throw sitesPrivateDemoError("Client routing qualification")}
export async function qualifyClientRoutingSource(versionId:string,sourceId:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).qualifyClientRoutingSource(versionId,sourceId,input);if(controlPlaneMode)return(await controlPlane()).qualifyClientRoutingSource(versionId,sourceId,input,idempotencyKey);throw sitesPrivateDemoError("Client routing qualification")}
export async function startNotionRoutingOAuth(integrationId?:string){if(fixtureMode)return(await fixture()).startNotionRoutingOAuth();if(controlPlaneMode)return(await controlPlane()).startNotionRoutingOAuth(integrationId);throw sitesPrivateDemoError("Notion routing connection")}
export async function completeNotionRoutingOAuth(input:Record<string,unknown>){if(fixtureMode)return(await fixture()).completeNotionRoutingOAuth(input);if(controlPlaneMode)return(await controlPlane()).completeNotionRoutingOAuth(input);throw sitesPrivateDemoError("Notion routing connection")}
export async function abortNotionRoutingOAuth(input:Record<string,unknown>){if(fixtureMode)return(await fixture()).abortNotionRoutingOAuth(input);if(controlPlaneMode)return(await controlPlane()).abortNotionRoutingOAuth(input);throw sitesPrivateDemoError("Notion routing connection")}
export async function syncClientRoutingSource(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).syncClientRoutingSource(id,input);if(controlPlaneMode)return(await controlPlane()).syncClientRoutingSource(id,input,idempotencyKey);throw sitesPrivateDemoError("Client routing source sync")}
export async function createClientRouting(input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).createClientRouting(input);if(controlPlaneMode)return(await controlPlane()).createClientRouting(input,idempotencyKey);throw sitesPrivateDemoError("Client routing")}
export async function activateClientRouting(id:string,input:Record<string,unknown>,idempotencyKey:string){if(fixtureMode)return(await fixture()).activateClientRouting(id,input);if(controlPlaneMode)return(await controlPlane()).activateClientRouting(id,input,idempotencyKey);throw sitesPrivateDemoError("Client routing")}
export async function simulateClientRouting(input:Record<string,unknown>){if(fixtureMode)return(await fixture()).simulateClientRouting(input);if(controlPlaneMode)return(await controlPlane()).simulateClientRouting(input);throw sitesPrivateDemoError("Client routing")}

export async function getRuleSetReadiness(id:string){
  if(fixtureMode)return(await fixture()).getRuleSetReadiness(id);
  if(controlPlaneMode)return(await controlPlane()).getRuleSetReadiness(id);
  throw Object.assign(new Error("Rule-set readiness requires the managed control plane"),{status:503});
}

export async function compareRuleSetVersions(leftId:string,rightId:string){
  if(fixtureMode)return(await fixture()).compareRuleSetVersions(leftId,rightId);
  if(controlPlaneMode)return(await controlPlane()).compareRuleSetVersions(leftId,rightId);
  throw Object.assign(new Error("Version comparison requires immutable managed rule-set snapshots"),{status:503});
}

export async function activateRuleSetVersion(id:string,input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).activateRuleSetVersion(id,input,actor);
  if(controlPlaneMode)return(await controlPlane()).activateRuleSetVersion(id,input,idempotencyKey);
  throw Object.assign(new Error("Rule-set activation requires the managed control plane"),{status:503});
}

export async function cloneRuleSetVersion(id:string,actor:string,idempotencyKey:string,input:Record<string,unknown>={}){
  if(fixtureMode)return(await fixture()).cloneRuleSetVersion(id,actor,idempotencyKey,input);
  if(controlPlaneMode)return(await controlPlane()).cloneRuleSetVersion(id,idempotencyKey,input);
  throw Object.assign(new Error("Rule-set cloning requires the managed control plane"),{status:503});
}

export async function rollbackRuleSetVersion(id:string,input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).rollbackRuleSetVersion(id,input,actor);
  if(controlPlaneMode)return(await controlPlane()).rollbackRuleSetVersion(id,input,idempotencyKey);
  throw Object.assign(new Error("Rule-set rollback requires the managed control plane"),{status:503});
}

export async function createConnection(input:{provider:"WAHA"|"META";name:string;engine?:"GOWS"|"NOWEB";disclosureAccepted?:boolean;disclosureVersion?:string;accessToken?:string;phoneNumberId?:string;wabaId?:string;eligibilityAccepted?:boolean;eligibilityVersion?:string},actor:string,idempotencyKey?:string){
  if(fixtureMode)return(await fixture()).createConnection(input,actor);
  if(controlPlaneMode)return(await controlPlane()).createConnection(input,actor,idempotencyKey);
  throw sitesPrivateDemoError("Live connection creation");
}

export async function getWorkspaceSettings(){
  if(fixtureMode)return(await fixture()).getWorkspaceSettings();
  if(controlPlaneMode)return(await controlPlane()).getWorkspaceSettings();
  throw Object.assign(new Error("Tenant administration requires the production control plane or fixture preview"),{status:503});
}

export async function updateWorkspaceSettings(input:Record<string,unknown>,actor:string){
  if(fixtureMode)return(await fixture()).updateWorkspaceSettings(input,actor);
  if(controlPlaneMode)return(await controlPlane()).updateWorkspaceSettings(input);
  throw Object.assign(new Error("Tenant administration requires the production control plane or fixture preview"),{status:503});
}

export async function getTeamAccess(){
  if(fixtureMode)return(await fixture()).getTeamAccess();
  if(controlPlaneMode)return(await controlPlane()).getTeamAccess();
  throw Object.assign(new Error("Team administration requires the production control plane or fixture preview"),{status:503});
}

export async function workspaceAccess(input:Record<string,unknown>){
  if(controlPlaneMode)return(await controlPlane()).workspaceAccess(input);
  if(input.action==="status")return{enabled:false,available:false,members:[]};
  throw Object.assign(new Error("Workspace account synchronization requires the managed control plane"),{status:503});
}

export async function getSupportAccessRequests(){
  if(fixtureMode)return(await fixture()).getSupportAccessRequests();
  if(controlPlaneMode)return(await controlPlane()).getSupportAccessRequests();
  return [];
}

export async function decideSupportAccess(id:string,action:"approve"|"deny"|"revoke",input:Record<string,unknown>,actor:string){
  if(fixtureMode)return(await fixture()).decideSupportAccess(id,action,input,actor);
  if(controlPlaneMode)return(await controlPlane()).decideSupportAccess(id,action,input);
  throw Object.assign(new Error("Support-access decisions require the managed control plane"),{status:503});
}

export async function exportAuditCsv(input:{from:string;to:string;limit:number}){
  if(controlPlaneMode)return(await controlPlane()).exportAuditCsv(input);
  const source=fixtureMode
    ? (await fixture()).getDashboardData().then(data=>data.audit)
    : all<Record<string,unknown>>("SELECT * FROM audit_events WHERE tenant_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?",TENANT_ID,input.from,input.to,input.limit);
  const rows=(await source).slice(0,input.limit);
  return{body:auditCsv(rows),filename:`wasalx-audit-${input.from.slice(0,10)}-${input.to.slice(0,10)}.csv`};
}

export async function getAuditEvents(cursor?:{createdAt:string;id:string},routine:"include"|"exclude"="exclude"){
  if(controlPlaneMode)return(await controlPlane()).getAuditEvents(cursor,routine);
  const rows=fixtureMode
    ? (await fixture()).getDashboardData().then(data=>data.audit)
    : all<Record<string,unknown>>(
      "SELECT * FROM audit_events WHERE tenant_id = ? AND (? IS NULL OR (created_at,id) < (?,?)) ORDER BY created_at DESC,id DESC LIMIT 100",
      TENANT_ID,cursor?.createdAt??null,cursor?.createdAt??null,cursor?.id??null,
    );
  const resolved=await rows;
  return resolved.filter(row=>!cursor||String(row.created_at)<cursor.createdAt||(String(row.created_at)===cursor.createdAt&&String(row.id)<cursor.id)).slice(0,100);
}

export async function inviteTeamMember(input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).inviteTeamMember(input,actor);
  if(controlPlaneMode)return(await controlPlane()).inviteTeamMember(input,idempotencyKey);
  throw Object.assign(new Error("Team administration requires the production control plane or fixture preview"),{status:503});
}

export async function resendTeamInvitation(id:string,input:Record<string,unknown>,actor:string,idempotencyKey:string){
  if(fixtureMode)return(await fixture()).resendTeamInvitation(id,input,actor);
  if(controlPlaneMode)return(await controlPlane()).resendTeamInvitation(id,input,idempotencyKey);
  throw Object.assign(new Error("Team administration requires the production control plane or fixture preview"),{status:503});
}

export async function revokeTeamInvitation(id:string,expectedVersion:number,actor:string){
  if(fixtureMode)return(await fixture()).revokeTeamInvitation(id,expectedVersion,actor);
  if(controlPlaneMode)return(await controlPlane()).revokeTeamInvitation(id,expectedVersion);
  throw Object.assign(new Error("Team administration requires the production control plane or fixture preview"),{status:503});
}

export async function updateTeamMember(id:string,input:Record<string,unknown>,actor:string){
  if(fixtureMode)return(await fixture()).updateTeamMember(id,input,actor);
  if(controlPlaneMode)return(await controlPlane()).updateTeamMember(id,input);
  throw Object.assign(new Error("Team administration requires the production control plane or fixture preview"),{status:503});
}

export async function removeTeamMember(id:string,expectedVersion:number,actor:string){
  if(fixtureMode)return(await fixture()).removeTeamMember(id,expectedVersion,actor);
  if(controlPlaneMode)return(await controlPlane()).removeTeamMember(id,expectedVersion);
  throw Object.assign(new Error("Team administration requires the production control plane or fixture preview"),{status:503});
}

export async function acceptWahaEvent(connectionToken: string, eventId: string, eventType: string, payload: string) {
  if(fixtureMode)return(await fixture()).acceptWahaEvent(connectionToken,eventId,eventType,payload);
  if(controlPlaneMode)throw new Error("Use the managed control-plane webhook ingress");
  throw sitesPrivateDemoError("Provider webhook ingestion");
}

export async function acceptProviderEvent(input:{tenantId:string;connectionId:string;provider:"WAHA"|"META";eventId:string;eventType:string;payload:string}){
  if(fixtureMode)return(await fixture()).acceptProviderEvent(input);
  if(!controlPlaneMode)throw sitesPrivateDemoError("Provider webhook ingestion");
  await initialize();
  try {
    await d1().prepare("INSERT INTO event_inbox (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,status,received_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.tenantId,input.connectionId,input.provider,input.eventId,input.eventType,input.payload,"ACCEPTED",new Date().toISOString()).run();
    return { duplicate: false };
  } catch (error) {
    if (String(error).includes("UNIQUE")) return { duplicate: true };
    throw error;
  }
}

export async function enqueueZammadOutbound(input:{tenantId:string;connectionId:string;groupId:string;ticketId:string;articleId:string;body:string;contentType:string;replyToMessageId?:string;idempotencyKey:string}){
  if(fixtureMode)return(await fixture()).enqueueZammadOutbound(input);
  if(!controlPlaneMode)throw sitesPrivateDemoError("Zammad outbound ingestion");
  await initialize();const now=new Date().toISOString();const id=crypto.randomUUID();
  try{await d1().prepare("INSERT INTO delivery_outbox (id,tenant_id,connection_id,group_id,zammad_ticket_id,zammad_article_id,message_body,content_type,reply_to_message_id,idempotency_key,state,attempts,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,input.tenantId,input.connectionId,input.groupId,input.ticketId,input.articleId,input.body,input.contentType,input.replyToMessageId??null,input.idempotencyKey,"QUEUED",0,now,now,now).run();return{id,state:"QUEUED" as const,duplicate:false}}
  catch(error){if(String(error).includes("UNIQUE")){const existing=await d1().prepare("SELECT id,state FROM delivery_outbox WHERE idempotency_key = ? AND tenant_id = ?").bind(input.idempotencyKey,input.tenantId).first<{id:string;state:string}>();if(existing)return{...existing,duplicate:true}}throw error}
}

export async function updateOutboundStatus(input:{tenantId:string;idempotencyKey:string;state:string;externalMessageId?:string;safeError?:string}){
  if(fixtureMode)return(await fixture()).updateOutboundStatus(input);
  if(!controlPlaneMode)throw sitesPrivateDemoError("Zammad delivery-status ingestion");
  await initialize();const allowed=new Set(["QUEUED","SENDING","SENT","DELIVERED","READ","FAILED_RETRYABLE","FAILED_TERMINAL"]);if(!allowed.has(input.state))throw new Error("Invalid delivery state");
  await d1().prepare("UPDATE delivery_outbox SET state = ?, external_message_id = COALESCE(?, external_message_id), last_error = ?, updated_at = ? WHERE tenant_id = ? AND idempotency_key = ?").bind(input.state,input.externalMessageId??null,input.safeError?.slice(0,500)??null,new Date().toISOString(),input.tenantId,input.idempotencyKey).run();
}

export async function retryOutboundByTicket(input:{tenantId:string;ticketId:string;articleId:string}){
  if(fixtureMode)return(await fixture()).retryOutboundByTicket(input);
  if(!controlPlaneMode)throw sitesPrivateDemoError("Zammad delivery retry");
  await initialize();
  const delivery=await d1().prepare("SELECT id,state FROM delivery_outbox WHERE tenant_id = ? AND zammad_ticket_id = ? AND zammad_article_id = ?").bind(input.tenantId,input.ticketId,input.articleId).first<{id:string;state:string}>();
  if(!delivery)throw new Error("Delivery not found");
  if(!["FAILED_RETRYABLE","FAILED_TERMINAL"].includes(delivery.state))throw new Error("Only failed deliveries can be retried");
  const now=new Date().toISOString();
  await d1().prepare("UPDATE delivery_outbox SET state = 'QUEUED', available_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?").bind(now,now,delivery.id,input.tenantId).run();
  return{id:delivery.id,state:"QUEUED" as const};
}

function auditCsv(rows:Record<string,unknown>[]){
  const columns=["created_at","actor","action","target","request_id","detail"];
  const records=rows.map(row=>columns.map(column=>csvCell(redactAuditValue(row[column]))));
  return `\uFEFF${[columns.map(csvCell),...records].map(record=>record.join(",")).join("\r\n")}\r\n`;
}

function redactAuditValue(value:unknown,depth=0):unknown{
  if(depth>8)return"[DEPTH_LIMIT]";
  if(Array.isArray(value))return value.slice(0,100).map(entry=>redactAuditValue(entry,depth+1));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).slice(0,200).map(([key,entry])=>[key,isSensitiveAuditKey(key)?"[REDACTED]":redactAuditValue(entry,depth+1)]));
  return typeof value==="string"&&value.length>2_000?`${value.slice(0,2_000)}…`:value??"";
}

function isSensitiveAuditKey(key:string){const normalized=key.toLowerCase().replaceAll(/[^a-z0-9]/gu,"");return["secret","token","password","credential","authorization","apikey","hmackey","routetoken","payload","messagebody","messagetext","rawbody","objectkey"].some(value=>normalized.includes(value))}
function csvCell(value:unknown){let textValue=typeof value==="object"?JSON.stringify(value):String(value??"");if(/^[=+\-@\t\r]/u.test(textValue))textValue=`'${textValue}`;return`"${textValue.replaceAll('"','""')}"`}

function staticZammadRoutingCatalog(){
  const fetchedAt=new Date();
  return{instanceId:"sites-private-demo",fetchedAt:fetchedAt.toISOString(),expiresAt:new Date(fetchedAt.getTime()+30_000).toISOString(),groups:[
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
function staticZammadGroupId(name:string){return new Map([["Riyadh Operations","2"],["Escalations","3"],["Linehaul","4"],["Priority Support","5"],["Returns","6"]]).get(name)}
