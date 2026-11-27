import {createHash,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {META_COST_SOURCE_MAX_BYTES,META_COST_SOURCE_MIMES,metaCostSourceKey,metaCostUuid,type MetaCostSourceMime} from "../../../packages/core/src/meta-cost.js";
import type {MediaScanner} from "../../../packages/core/src/media.js";
import {MediaRuntimeError,type S3MediaStorage} from "./media-runtime.js";

export class MetaCostSourceError extends Error {
  constructor(readonly code:string,readonly retryable=false){super("Cost source is unavailable");}
}
type SourceReservation={id:string;tenantId:string;objectKey:string;sha256:string;byteSize:number;mimeType:MetaCostSourceMime;version:number;sourceState:string;writeAttemptId:string|null};
type SourceWrite=SourceReservation&{writeAttemptId:string};

/** A narrow DB adapter, using the existing worker pool and tenant transaction.
 * SQL owns authority/currentness/privacy/write fencing; no local mode override. */
export class MetaCostSourceRepository {
  constructor(private readonly pool:Pool){}
  private async call<T>(tenantId:string,sql:string,values:unknown[]):Promise<T>{
    const client=await this.pool.connect();try{
      await client.query("BEGIN");await client.query("SELECT set_config('app.tenant_id',$1,true)",[metaCostUuid(tenantId)]);
      const result=(await client.query<{value:T}>(sql,values)).rows[0]?.value;
      await client.query("COMMIT");if(result===undefined)throw new MetaCostSourceError("SOURCE_NOT_FOUND");return result;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  reservation(tenantId:string,id:string){return this.call<SourceReservation>(tenantId,"SELECT app.meta_cost_source_access($1,$2,false) AS value",[tenantId,id]);}
  readable(tenantId:string,id:string){return this.call<SourceReservation>(tenantId,"SELECT app.meta_cost_source_access($1,$2,true) AS value",[tenantId,id]);}
  admit(tenantId:string,id:string,version:number,writeAttemptId:string,scanSha256:string){return this.call<SourceWrite>(tenantId,
    "SELECT app.admit_meta_cost_source_write($1,$2,$3,$4,$5) AS value",[tenantId,id,version,writeAttemptId,scanSha256]);}
  settle(tenantId:string,id:string,writeAttemptId:string,outcome:"WRITTEN"|"NOT_WRITTEN"|"UNKNOWN",scanSha256:string){return this.call<{state:string}>(tenantId,
    "SELECT app.settle_meta_cost_source_write($1,$2,$3,$4,$5) AS value",[tenantId,id,writeAttemptId,outcome,scanSha256]);}
  reject(tenantId:string,id:string,version:number,reason:"SCAN_REJECTED"|"SOURCE_INVALID"){return this.call<{state:string}>(tenantId,
    "SELECT app.reject_meta_cost_source_before_write($1,$2,$3,$4) AS value",[tenantId,id,version,reason]);}
}

export class MetaCostSourceService {
  constructor(private readonly repository:MetaCostSourceRepository,private readonly scanner:MediaScanner,private readonly storage:Pick<S3MediaStorage,"put"|"get">){}

  async upload(tenantId:string,id:string,bytes:Uint8Array,mimeType:string){
    const reserved=await this.repository.reservation(tenantId,id);assertReservation(reserved,tenantId,id);
    if(bytes.byteLength!==reserved.byteSize||bytes.byteLength<1||bytes.byteLength>META_COST_SOURCE_MAX_BYTES
      ||mimeType!==reserved.mimeType||hash(bytes)!==reserved.sha256)throw new MetaCostSourceError("SOURCE_INTEGRITY_MISMATCH");
    assertSourceBytes(bytes,reserved.mimeType);
    if(reserved.sourceState==="READY")return{id:reserved.id,state:"READY"};
    if(reserved.sourceState!=="RESERVED")throw new MetaCostSourceError("SOURCE_WRITE_UNRESOLVED");
    const scan=await this.scanner.scan(bytes,reserved.mimeType);
    if(scan.state==="ERROR")throw new MetaCostSourceError("SOURCE_SCAN_UNAVAILABLE",true);
    if(scan.state!=="CLEAN"){
      await this.repository.reject(tenantId,id,reserved.version,"SCAN_REJECTED");
      throw new MetaCostSourceError("SOURCE_SCAN_REJECTED");
    }
    const scanSha256=hash(new TextEncoder().encode(JSON.stringify({sha256:reserved.sha256,state:scan.state,engine:scan.engine})));
    const admitted=await this.repository.admit(tenantId,id,reserved.version,randomUUID(),scanSha256);assertReservation(admitted,tenantId,id);
    // One persisted admitted attempt exists before any storage request. Scan or
    // admission failure above cannot create an object; no network call in a tx.
    try {
      await this.storage.put(admitted.objectKey,bytes,{mime_type:admitted.mimeType,tenant_id:tenantId,meta_cost_statement_id:id,sha256:admitted.sha256});
    }catch(error){
      // Only an observed definitive HTTP rejection from the installed transport
      // can establish NOT_WRITTEN. Network timeout/abort/crash remains UNKNOWN.
      const outcome=error instanceof MediaRuntimeError&&error.code==="MEDIA_STORAGE_HTTP"&&!error.retryable?"NOT_WRITTEN":"UNKNOWN";
      try {
        await this.repository.settle(tenantId,id,admitted.writeAttemptId,outcome,scanSha256);
      } catch {
        throw new MetaCostSourceError("SOURCE_WRITE_UNRESOLVED");
      }
      throw new MetaCostSourceError(outcome==="UNKNOWN"?"SOURCE_WRITE_OUTCOME_UNKNOWN":"SOURCE_STORAGE_REJECTED");
    }
    // If this DB call fails after PUT, durable ADMITTED/UNKNOWN remains. Neither
    // readiness nor a cleanup completion is guessed from local storage success.
    const result=await this.repository.settle(tenantId,id,admitted.writeAttemptId,"WRITTEN",scanSha256);
    if(result.state!=="READY")throw new MetaCostSourceError("SOURCE_WRITE_REQUIRES_REVIEW");
    return{id,state:"READY"};
  }

  async original(tenantId:string,id:string){
    const before=await this.repository.readable(tenantId,id);assertReservation(before,tenantId,id);
    const bytes=await this.storage.get(before.objectKey,before.byteSize,before.mimeType);
    if(bytes.byteLength!==before.byteSize||hash(bytes)!==before.sha256)throw new MetaCostSourceError("SOURCE_INTEGRITY_MISMATCH");
    const after=await this.repository.readable(tenantId,id);assertReservation(after,tenantId,id);
    if(after.version!==before.version||after.objectKey!==before.objectKey||after.sha256!==before.sha256
      ||after.byteSize!==before.byteSize||after.mimeType!==before.mimeType)throw new MetaCostSourceError("SOURCE_CHANGED");
    return{bytes,mimeType:before.mimeType,sha256:before.sha256};
  }
}

function hash(bytes:Uint8Array){return createHash("sha256").update(bytes).digest("hex");}
function assertReservation(value:SourceReservation,tenantId:string,id:string){
  if(value.tenantId!==tenantId||value.id!==id||value.objectKey!==metaCostSourceKey(tenantId,id,value.sha256)
    ||!META_COST_SOURCE_MIMES.includes(value.mimeType)||!Number.isSafeInteger(value.byteSize)||value.byteSize<1||value.byteSize>META_COST_SOURCE_MAX_BYTES)
    throw new MetaCostSourceError("SOURCE_RESERVATION_INVALID");
}
function assertSourceBytes(bytes:Uint8Array,mime:MetaCostSourceMime){
  if(mime==="application/pdf"){
    if(new TextDecoder().decode(bytes.slice(0,5))!=="%PDF-")throw new MetaCostSourceError("SOURCE_TYPE_INVALID");
    return;
  }
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new MetaCostSourceError("SOURCE_TYPE_INVALID");}
  if(text.includes("\0")||!text.trim()||/^\s*<(?:!doctype|html|script)\b/iu.test(text))throw new MetaCostSourceError("SOURCE_TYPE_INVALID");
  if(mime==="application/json")try{JSON.parse(text);}catch{throw new MetaCostSourceError("SOURCE_TYPE_INVALID");}
}
