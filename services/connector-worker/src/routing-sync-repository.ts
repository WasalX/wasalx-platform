import { Pool, type PoolClient } from "pg";
import type { ClientRoutingDefinition, ClientRoutingSourceSnapshot } from "../../../packages/core/src/client-routing.js";

export type RoutingSyncJob={id:string;tenantId:string;sourceStateId:string;sourceId:string;kind:"NOTION"|"ZOHO"|"HTTP_JSON";syncMode:"WEBHOOK"|"SCHEDULED"|"HYBRID"|"QUALIFICATION";secretReference:string;endpointUrl?:string;scheduleMinutes?:number;fieldMapping:Record<string,string>;configSha256:string;snapshot:Record<string,unknown>[];snapshotRevision:number;cursorValue?:string;attempts:number;fencingToken:number};
export type RoutingSourceState={sourceId:string;snapshot:ClientRoutingSourceSnapshot};
export type RoutingSyncContext={definition:ClientRoutingDefinition;states:RoutingSourceState[];zammadBaseUrl:string;zammadSecretReference:string};
type ClaimRow={job_id:string;source_state_id:string;source_id:string;kind:RoutingSyncJob["kind"];sync_mode:RoutingSyncJob["syncMode"];secret_reference:string;endpoint_url:string|null;schedule_minutes:number|null;field_mapping:Record<string,string>;config_sha256:string;snapshot:Record<string,unknown>[];snapshot_revision:string|number;cursor_value:string|null;attempts:number;fencing_token:string|number};

export class RoutingSyncRepository{
  constructor(private readonly pool:Pool){}
  async ready(){const client=await this.pool.connect();try{await client.query("SELECT 1");return true}catch{return false}finally{client.release()}}
  async close(){await this.pool.end()}
  claim(tenantId:string,leaseId:string,limit=5){return this.tenant(tenantId,async client=>(await client.query<ClaimRow>("SELECT * FROM app.claim_client_routing_sync_jobs($1,$2)",[leaseId,limit])).rows.map(row=>({id:row.job_id,tenantId,sourceStateId:row.source_state_id,sourceId:row.source_id,kind:row.kind,syncMode:row.sync_mode,secretReference:row.secret_reference,endpointUrl:row.endpoint_url??undefined,scheduleMinutes:row.schedule_minutes??undefined,fieldMapping:row.field_mapping,configSha256:row.config_sha256,snapshot:row.snapshot,snapshotRevision:Number(row.snapshot_revision),cursorValue:row.cursor_value??undefined,attempts:row.attempts,fencingToken:Number(row.fencing_token)})))}
  bindingActive(job:RoutingSyncJob){return this.tenant(job.tenantId,async client=>(await client.query<{active:boolean}>(`SELECT EXISTS(
      SELECT 1 FROM client_routing_integrations integration
       WHERE integration.tenant_id=$1 AND integration.secret_reference=$2
         AND integration.provider=$3 AND integration.state='CONNECTED'
    ) AS active`,[job.tenantId,job.secretReference,job.kind])).rows[0]?.active===true)}
  context(tenantId:string){return this.tenant(tenantId,async client=>{
    const active=(await client.query<{definition:ClientRoutingDefinition;base_url:string;service_secret_reference:string}>(`SELECT routing.definition,zammad.base_url,zammad.service_secret_reference
      FROM client_routing_versions routing JOIN zammad_instances zammad ON zammad.tenant_id=routing.tenant_id AND zammad.state='WORKING'
      WHERE routing.tenant_id=$1 AND routing.state='ACTIVE'`,[tenantId])).rows[0];
    if(!active)throw new Error("Active client routing or Zammad workspace is unavailable");
    const states=(await client.query<{source_id:string;snapshot:Record<string,unknown>[];snapshot_revision:string|number}>("SELECT source_id,snapshot,snapshot_revision FROM client_routing_source_state WHERE tenant_id=$1 AND state='ACTIVE' ORDER BY source_id",[tenantId])).rows.map(row=>({sourceId:row.source_id,snapshot:{sourceId:row.source_id,revision:Number(row.snapshot_revision),rows:row.snapshot}}));
    return{definition:active.definition,states,zammadBaseUrl:active.base_url,zammadSecretReference:active.service_secret_reference};
  })}
  renew(job:RoutingSyncJob,leaseId:string){return this.tenant(job.tenantId,async client=>(await client.query<{renewed:boolean}>("SELECT app.renew_client_routing_sync_job($1,$2,$3,interval '2 minutes') AS renewed",[job.id,leaseId,job.fencingToken])).rows[0]?.renewed===true)}
  complete(job:RoutingSyncJob,leaseId:string,context:RoutingSyncContext,snapshot:ClientRoutingSourceSnapshot,cursor:string|undefined,definition:ClientRoutingDefinition){return this.tenant(job.tenantId,async client=>{
    const revisions=Object.fromEntries(context.states.map(state=>[state.sourceId,state.snapshot.revision]));
    const row=(await client.query<{routing_version_id:string;version:number}>("SELECT * FROM app.complete_client_routing_sync_job($1,$2,$3,$4,$5,$6,$7)",[job.id,leaseId,job.fencingToken,revisions,JSON.stringify(snapshot.rows),cursor??null,definition])).rows[0];
    if(!row)throw new Error("Routing sync completion fence was lost");return row;
  })}
  completeQualification(job:RoutingSyncJob,leaseId:string){return this.tenant(job.tenantId,async client=>(await client.query<{completed:boolean}>("SELECT app.complete_client_routing_source_qualification($1,$2,$3) AS completed",[job.id,leaseId,job.fencingToken])).rows[0]?.completed===true)}
  revokeBinding(job:RoutingSyncJob,leaseId:string,safeError:string){return this.tenant(job.tenantId,async client=>(await client.query<{integration_id:string|null}>("SELECT app.revoke_client_routing_integration_for_sync($1,$2,$3,$4) AS integration_id",[job.id,leaseId,job.fencingToken,safeError.slice(0,500)])).rows[0]?.integration_id??null)}
  fail(job:RoutingSyncJob,leaseId:string,retryable:boolean,safeError:string,retryAt?:string){return this.tenant(job.tenantId,async client=>{
    const row=(await client.query<{completed:boolean}>("SELECT app.fail_client_routing_sync_job($1,$2,$3,$4,$5,$6) AS completed",[job.id,leaseId,job.fencingToken,retryable,safeError.slice(0,500),retryAt??null])).rows[0];
    if(!row?.completed)throw new Error("Routing sync failure fence was lost");
  })}
  private async tenant<T>(tenantId:string,operation:(client:PoolClient)=>Promise<T>){const client=await this.pool.connect();try{await client.query("BEGIN");await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const result=await operation(client);await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
}
