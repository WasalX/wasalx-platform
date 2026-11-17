import type { NativeMembership } from "./native-membership.service.js";

export type NativeAccountObservation={state:"VERIFIED"|"DRIFT"|"UNAVAILABLE"|"UNVERIFIED";checkedAt:string|null;revision:number;nativeUserId:string|null};
export type MembershipObservationSnapshot=NativeMembership&{current_instance_id:string|null;base_url:string;service_secret_reference:string;source_identity_current:boolean;source_display_name:string|null};
export type CapturedMembershipIdentity=Partial<Pick<NativeMembership,"email"|"display_name"|"role"|"member_state"|"native_user_id"|"revision"|"applied_revision"|"sync_state">>;
type NativeObservationResult={state:string;revision?:number;native_user_id?:string};
type CacheEntry={expires:number;value:NativeAccountObservation};
const nativeId=(value:unknown):value is string=>typeof value==="string"&&/^[1-9][0-9]{0,15}$/u.test(value)&&Number.isSafeInteger(Number(value));
const revision=(value:unknown)=>Number.isSafeInteger(Number(value))&&Number(value)>0;
export function unverifiedNativeAccount(row?:Pick<NativeMembership,"revision"|"native_user_id">):NativeAccountObservation{
  return{state:"UNVERIFIED",checkedAt:null,revision:row&&revision(row.revision)?Number(row.revision):0,nativeUserId:row&&nativeId(row.native_user_id)?row.native_user_id:null};
}

/** Read-only, bounded observations shared by both membership presentation surfaces. */
export class NativeMembershipObserver{
  private readonly cache=new Map<string,CacheEntry>();
  private readonly inFlight=new Map<string,Promise<NativeAccountObservation>>();
  private cursor=0;
  constructor(private readonly read:(tenantId:string,userIds?:string[])=>Promise<MembershipObservationSnapshot[]>,
    private readonly discover:(row:MembershipObservationSnapshot,signal:AbortSignal)=>Promise<NativeObservationResult>,
    private readonly budgetMs=8_000){}
  async observe(tenantId:string,userIds?:string[],captured?:ReadonlyMap<string,CapturedMembershipIdentity>){
    const deadline=Date.now()+this.budgetMs;
    this.prune();
    const rows=(await within(this.read(tenantId,userIds),deadline,[])).filter(row=>row.tenant_id===tenantId&&(!userIds||userIds.includes(row.user_id)));
    const result=new Map(rows.map(row=>[row.user_id,unverifiedNativeAccount(row)]));
    const eligible=rows.filter(row=>this.eligible(row)&&(!captured||this.matchesCapture(row,captured.get(row.user_id))));if(!eligible.length)return result;
    // A slow first batch must not permanently starve members later in the list.
    const offset=this.cursor%eligible.length;
    const ordered=[...eligible.slice(offset),...eligible.slice(0,offset)];let next=0;
    const work=async()=>{
      while(next<ordered.length&&Date.now()<deadline){
        const row=ordered[next++]!;
        result.set(row.user_id,await this.observation(row,deadline));
      }
    };
    await Promise.all(Array.from({length:Math.min(4,eligible.length)},work));
    for(const row of rows){const observed=result.get(row.user_id);if(observed?.checkedAt&&Date.now()-Date.parse(observed.checkedAt)>=3_000)result.set(row.user_id,unverifiedNativeAccount(row));}
    return result;
  }
  private eligible(row:MembershipObservationSnapshot){return row.source_identity_current===true&&row.sync_state==="READY"&&revision(row.revision)
    &&Number(row.revision)===Number(row.applied_revision)&&nativeId(row.native_user_id)&&!!row.zammad_instance_id&&row.zammad_instance_id===row.current_instance_id;}
  private matchesCapture(row:MembershipObservationSnapshot,captured?:CapturedMembershipIdentity){
    if(!captured)return false;
    return Object.entries(captured).every(([key,value])=>key==="revision"||key==="applied_revision"
      ?Number(row[key])===Number(value):key==="display_name"?row.source_display_name===value:row[key as keyof CapturedMembershipIdentity]===value);
  }
  private key(row:MembershipObservationSnapshot){return JSON.stringify([row.tenant_id,row.user_id,row.oidc_subject,row.email,row.display_name,row.role,row.member_state,
    row.revision,row.applied_revision,row.native_user_id,row.requested_native_user_id,row.zammad_instance_id,row.current_instance_id,row.base_url,row.service_secret_reference,row.source_display_name]);}
  private async observation(row:MembershipObservationSnapshot,deadline:number){
    const key=this.key(row),cached=this.cache.get(key);
    if(cached&&cached.expires>Date.now())return cached.value;
    let pending=this.inFlight.get(key);
    if(!pending){
      if(this.inFlight.size>=4)return unverifiedNativeAccount(row);
      this.cursor=(this.cursor+1)%Number.MAX_SAFE_INTEGER;
      pending=this.inspect(row,deadline).finally(()=>this.inFlight.delete(key));
      this.inFlight.set(key,pending);
    }
    return within(pending,deadline,unverifiedNativeAccount(row));
  }
  private async inspect(row:MembershipObservationSnapshot,deadline:number):Promise<NativeAccountObservation>{
    const fallback=unverifiedNativeAccount(row),remaining=deadline-Date.now();if(remaining<=0)return fallback;
    const signal=AbortSignal.timeout(remaining);
    let state:NativeAccountObservation["state"]="UNAVAILABLE";
    try{
      const response=await this.discover(row,signal);
      const exact=response.revision===Number(row.revision)&&response.native_user_id===row.native_user_id;
      if(response.state==="READY"&&exact)state="VERIFIED";
      else if(response.state==="CONFLICT"&&(response.revision===undefined||response.revision===Number(row.revision))&&(response.native_user_id===undefined||response.native_user_id===row.native_user_id))state="DRIFT";
      else state="UNVERIFIED";
    }catch{/* A provider/credential failure is a warning, never a source lifecycle transition. */}
    if(signal.aborted||Date.now()>=deadline)return fallback;
    // Remote work has finished; re-read Source without holding a transaction over HTTP.
    const current=(await within(this.read(row.tenant_id,[row.user_id]),deadline,[]))[0];
    if(signal.aborted||!current||!this.eligible(current)||this.key(current)!==this.key(row))return fallback;
    const value:NativeAccountObservation={...fallback,state,checkedAt:new Date().toISOString()};
    this.cache.delete(this.key(row));this.cache.set(this.key(row),{expires:Date.now()+3_000,value});this.prune();
    return value;
  }
  private prune(){for(const [key,value]of this.cache)if(value.expires<=Date.now())this.cache.delete(key);while(this.cache.size>256)this.cache.delete(this.cache.keys().next().value!);}
}

async function within<T>(promise:Promise<T>,deadline:number,fallback:T):Promise<T>{
  const remaining=deadline-Date.now();if(remaining<=0){void promise.catch(()=>undefined);return fallback;}
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise.catch(()=>fallback),new Promise<T>(resolve=>{timer=setTimeout(()=>resolve(fallback),remaining);})]);}
  finally{if(timer)clearTimeout(timer);}
}
