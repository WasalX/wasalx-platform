import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "./types.js";

type OperationRow={action:string;request_sha256:string;result:Record<string,unknown>};

export function requireOperationKey(value:unknown){
  const key=String(value??"");
  if(!key||key!==key.trim()||key.length>255||/\s/u.test(key)||[...key].some(character=>{const code=character.codePointAt(0)!;return code===127||code<32}))
    throw new BadRequestException("A valid Idempotency-Key header is required");
  return key;
}

/** Read a saved result before state-dependent preflight; the short transaction ends before any RPC. */
export async function findOperationReceipt(client:PoolClient,principal:Principal,action:string,
  idempotencyKey:string,requestSha256:string,conflictMessage="Idempotency key was already used for another operation",legacyRequestSha256?:string){
  const key=requireOperationKey(idempotencyKey);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`bot-flow:${principal.tenantId}:${key}`]);
  const replay=(await client.query<OperationRow>(
    "SELECT action,request_sha256,result FROM bot_flow_operations WHERE tenant_id=$1 AND idempotency_key=$2",
    [principal.tenantId,key],
  )).rows[0];
  if(replay){
    if(replay.action!==action||(replay.request_sha256!==requestSha256&&replay.request_sha256!==legacyRequestSha256))throw new ConflictException(conflictMessage);
    return{...replay.result,duplicate:true};
  }
  return null;
}

export async function withOperationReceipt<T extends Record<string,unknown>>(client:PoolClient,principal:Principal,action:string,
  idempotencyKey:string,requestSha256:string,requestId:string,operation:()=>Promise<T>,conflictMessage="Idempotency key was already used for another operation",legacyRequestSha256?:string){
  const replay=await findOperationReceipt(client,principal,action,idempotencyKey,requestSha256,conflictMessage,legacyRequestSha256);
  if(replay)return replay;
  const key=requireOperationKey(idempotencyKey);
  const result=await operation();
  await client.query(
    "INSERT INTO bot_flow_operations (tenant_id,action,idempotency_key,request_sha256,result,requested_by,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [principal.tenantId,action,key,requestSha256,result,principal.userId,requestId],
  );
  return{...result,duplicate:false};
}
