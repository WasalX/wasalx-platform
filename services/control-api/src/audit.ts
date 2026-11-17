import type { PoolClient } from "pg";
import type { Principal } from "./types.js";

export async function appendAudit(client:PoolClient,principal:Principal,input:{action:string;targetType:string;targetId:string;requestId:string;previousValue?:unknown;newValue?:unknown}){
  await client.query("INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id) VALUES ($1,'USER',$2,$3,$4,$5,$6,$7,$8)",[principal.tenantId,principal.userId,input.action,input.targetType,input.targetId,input.previousValue??null,input.newValue??null,input.requestId]);
}
