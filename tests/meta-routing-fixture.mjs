import { createHash, randomUUID } from "node:crypto";
import { metaRoutingRuntime } from "../packages/core/dist/meta-routing.js";

// Isolated simulated fixtures only; the scoped environment never grants authority.
// observeRoutingFixture below exercises the real privileged PostgreSQL role.
export function routingFixtureEnvironment(appId) {
  const next = { META_APP_ID:appId, META_GRAPH_VERSION:"v24.0", META_GRAPH_BASE_URL:"https://routing-provider.invalid",
    META_ROUTING_SIMULATION_BINDING_SHA256:"7".repeat(64), NODE_ENV:"test", PORTAL_PUBLIC_ORIGIN:"https://portal.invalid" };
  const before = Object.fromEntries(Object.keys(next).map(key=>[key,process.env[key]]));
  Object.assign(process.env,next);
  return ()=>{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value}};
}

export async function observeRoutingFixture(admin,{tenantId,connectionId,sessionId,appId,version=1,reviewVersion=0,roles=["escalation","customer_service"]}) {
  const observedAt=new Date(Date.now()-5000).toISOString();
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaRouting}',$1::jsonb) WHERE tenant_id=$2 AND id=$3",
    [{version,fallback:"HOLD",declaredAt:new Date(Date.now()-10000).toISOString()},tenantId,sessionId]));
  const body={expectedSessionId:sessionId,expectedConfigurationVersion:version,expectedReviewVersion:reviewVersion,disposition:"REVIEWED",observedAt,
    evidenceSha256:"6".repeat(64),evidenceReference:"synthetic/canonical-routing",scope:"PHONE_OVERRIDE",roles,targets:["customer_service"],
    fields:["messages","standby","messaging_handovers"],termsAccepted:true,threadControlEnabled:true,personallyObserved:true};
  await admin.query("BEGIN");
  try{
    await admin.query("SET LOCAL ROLE wasalx_platform_operations_client");
    const result=await admin.query("SELECT app.operator_record_meta_routing_review($1,$2,$3,$4,$5,$6,$7,$8,$9) AS review",
      [tenantId,connectionId,body,appId,metaRoutingRuntime(process.env),randomUUID(),createHash("sha256").update(JSON.stringify(body)).digest("hex"),"synthetic-routing-operator",randomUUID()]);
    await admin.query("COMMIT");return result.rows[0].review;
  }catch(error){await admin.query("ROLLBACK");throw error}
}

// Explicit positive fixture writes only. Negative role/scope probes remain separate.
export async function withFixtureTenant(client,tenantId,work) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    const result=await work();await client.query('COMMIT');return result;
  } catch(error) {
    try {await client.query('ROLLBACK');} catch(cleanupError) {throw new AggregateError([error,cleanupError],'Fixture operation and rollback failed');}
    throw error;
  }
}
