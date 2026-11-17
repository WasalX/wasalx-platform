// Called only by the disposable PostgreSQL integration gate; never starts workers or providers.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { ZammadGroupWorkspaceController } from "../services/control-api/dist/group-workspace.controller.js";
import { groupWorkspaceOperationKey } from "../services/control-api/dist/group-workspace-operation.js";

export async function verifyGroupWorkspaceReceipts(admin,appUrl){
  const tenantId="10000000-0000-4000-8000-000000000001",foreignTenant="20000000-0000-4000-8000-000000000002";
  const connectionId=randomUUID(),groupId=randomUUID(),messageId=randomUUID(),userId=randomUUID(),externalGroup=`${randomUUID()}@g.us`;
  const clients=[new Client({connectionString:appUrl}),new Client({connectionString:appUrl})],connected=[];
  let owned=false,primary,wakes=0,lastAlias,lastReceiptAlias;
  const tx=async(client,tenant,fn)=>{
    await client.query("BEGIN");
    try{await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);await client.query("SET LOCAL statement_timeout='8s'");const value=await fn(client);await client.query("COMMIT");return value;}
    catch(error){await client.query("ROLLBACK");throw error;}
  };
  let claims,previousEnabled,previousNativeEnabled;
  const controller=(client,{hold,fault,actor=claims}={})=>new ZammadGroupWorkspaceController({withTenant:async(tenant,fn)=>tx(client,tenant,async c=>{
    const value=await fn({query:async(sql,v)=>{
      if(sql.includes("SELECT id,idempotency_key FROM delivery_outbox"))lastAlias={sql,values:v};
      if(sql.includes("lower(receipt.idempotency_key)"))lastReceiptAlias={sql,values:v};
      const result=await c.query(sql,v);
      if((fault==="queue"&&sql.includes("INSERT INTO delivery_outbox"))||(fault==="receipt"&&sql.includes("INSERT INTO group_workspace_operation_receipts")))throw new Error(`Injected ${fault} rollback`);
      return result;
    }});
    if(hold){hold.ready();await hold.released;}
    return value;
  })},{verify:async()=>actor},{wake:async()=>{wakes++;}});
  const metadata=(kind,requestId,action="LOOKUP")=>({kind,requestId,action,...(kind==="REACTION"?{targetMessageId:messageId}:{})});
  const submit=(control,kind,requestId,body)=>kind==="SEND"
    ?control.send("synthetic verified claims",`group-workspace:${claims.userId}:${requestId}`,groupId,body??{message:"Synthetic group receipt",agentDisplayName:"Receipt agent"})
    :control.react("synthetic verified claims",`group-workspace-reaction:${claims.userId}:${requestId}`,groupId,messageId,body??{emoji:"✅"});
  const receipt=(control,kind,requestId,action="LOOKUP")=>control.operationReceipt("synthetic verified claims",groupId,metadata(kind,requestId,action));
  const read=sql=>tx(clients[0],tenantId,c=>c.query(sql,[tenantId,groupId]));
  const overlap=async(holder,waiter)=>{
    for(let n=0;n<100;n++){if((await admin.query("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",[holder,waiter])).rows[0].blocked)return;await delay(20);}
    throw new Error("Group operation race did not overlap on PostgreSQL advisory lock");
  };
  try{
    await tx(admin,tenantId,async c=>{
      const instance=(await c.query("SELECT id FROM zammad_instances WHERE tenant_id=$1 AND state='WORKING'",[tenantId])).rows[0];assert(instance);
      claims={tenantId,instanceId:instance.id,subject:instance.id,userId:"877193",groupIds:[],groupAdmin:false};
      assert.equal((await c.query("SELECT count(*)::int n FROM native_membership_projections WHERE tenant_id=$1 AND native_user_id=ANY($2::text[])",[tenantId,["877193","877194"]])).rows[0].n,0);
      const settings=(await c.query("SELECT group_workspace_enabled,native_membership_sync_enabled FROM tenant_settings WHERE tenant_id=$1",[tenantId])).rows[0];
      previousEnabled=settings.group_workspace_enabled;previousNativeEnabled=settings.native_membership_sync_enabled;
      await c.query("UPDATE tenant_settings SET group_workspace_enabled=true,native_membership_sync_enabled=true WHERE tenant_id=$1",[tenantId]);
      await c.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Group receipt fixture','WAHA','GOWS','WORKING',$3)",[connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/waha`]);
      await c.query("INSERT INTO provider_sessions(tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state) VALUES($1,$2,$3,'WORKING',$4,'ACTIVE')",[tenantId,connectionId,`receipt-${connectionId}`,`session://${connectionId}`]);
      await c.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Group receipt fixture')",[groupId,tenantId,connectionId,externalGroup]);
      await c.query("INSERT INTO group_workspace_settings(tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by) VALUES($1,$2,true,now()-interval '1 hour',30,'ALL_AGENTS','10100000-0000-4000-8000-000000000001')",[tenantId,groupId]);
      await c.query("INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES($1,$2,$3,'WAHA',$4,'message.any','{}',$5,'PROCESSED')",[messageId,tenantId,connectionId,`receipt-${messageId}`,"f".repeat(64)]);
      await c.query("INSERT INTO normalized_messages(id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status,history_captured_at) VALUES($1,$2,$1,$3,$4,$5,'12025550120@c.us','Synthetic receipt target',now(),'{}','COMPLETE',now())",[messageId,tenantId,connectionId,`external-${messageId}`,externalGroup]);
      await c.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Receipt managed agent')",[userId,`receipt-${userId}`,`receipt-${userId}@example.invalid`]);
      await c.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'agent','ACTIVE')",[tenantId,userId]);
      await c.query("INSERT INTO native_membership_projections(tenant_id,user_id,oidc_subject,email,display_name,role,member_state,revision,zammad_instance_id,native_user_id,applied_revision,sync_state) VALUES($1,$2,$3,$4,'Receipt managed agent','agent','ACTIVE',4,$5,'877194',4,'READY') ON CONFLICT(tenant_id,user_id) DO UPDATE SET revision=4,zammad_instance_id=$5,native_user_id='877194',applied_revision=4,sync_state='READY'",[tenantId,userId,`receipt-${userId}`,`receipt-${userId}@example.invalid`,claims.instanceId]);
    });owned=true;
    for(const c of clients){await c.connect();connected.push(c);}
    const pids=await Promise.all(clients.map(async c=>(await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    const control=controller(clients[0]);
    for(const kind of ["SEND","REACTION"]){
      assert.deepEqual(await receipt(control,kind,randomUUID()),{outcome:"UNKNOWN",terminal:false});
      for(const first of ["ADMIT","CANCEL"])for(const firstUpper of [false,true]){
        const requestId=`abcdefab${randomUUID().slice(8)}`,firstId=firstUpper?requestId.toUpperCase():requestId,secondId=firstUpper?requestId:requestId.toUpperCase();let announce,release;
        const ready=new Promise(resolve=>{announce=resolve;}),released=new Promise(resolve=>{release=resolve;});
        const holder=controller(clients[0],{hold:{ready:announce,released}}),waiter=controller(clients[1]);
        const leading=(first==="ADMIT"?submit(holder,kind,firstId):receipt(holder,kind,firstId,"CANCEL_IF_UNADMITTED"));
        await Promise.race([ready,leading]);
        const trailing=(first==="ADMIT"?receipt(waiter,kind,secondId,"CANCEL_IF_UNADMITTED"):submit(waiter,kind,secondId)).then(value=>({value}),error=>({error}));
        try{await overlap(pids[0],pids[1]);}finally{release();}
        const original=await leading,after=await trailing;
        if(first==="ADMIT"){
          assert.equal(original.duplicate,false);assert.equal(after.value.outcome,"ADMITTED");assert.equal(after.value.deliveryId,original.id);
          assert.equal((await submit(control,kind,requestId)).duplicate,true);
        }else{
          assert.deepEqual(original,{outcome:"NOT_APPLIED",terminal:true});assert.equal(after.error?.getResponse()?.code,"GROUP_OPERATION_CANCELLED");
          await assert.rejects(()=>submit(control,kind,requestId),error=>error.getResponse()?.code==="GROUP_OPERATION_CANCELLED");
        }
        const key=groupWorkspaceOperationKey(kind,claims.userId,requestId);
        await tx(clients[0],tenantId,async c=>{
          assert.equal((await c.query("SELECT count(*)::int n FROM group_workspace_operation_receipts WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,key])).rows[0].n,1);
          assert.equal((await c.query("SELECT count(*)::int n FROM delivery_outbox WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,key])).rows[0].n,first==="ADMIT"?1:0);
        });
      }
      for(const fault of ["queue","receipt"]){
        const requestId=randomUUID(),key=groupWorkspaceOperationKey(kind,claims.userId,requestId),beforeWakes=wakes;
        await assert.rejects(()=>submit(controller(clients[0],{fault}),kind,requestId),/Injected/);
        await tx(clients[0],tenantId,async c=>{
          for(const table of ["delivery_outbox","group_workspace_operation_receipts"])assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND idempotency_key=$2`,[tenantId,key])).rows[0].n,0);
        });assert.equal(wakes,beforeWakes);
      }
    }
    const multipartId=randomUUID(),uploadId=randomUUID(),body={message:"Synthetic attachment",agentDisplayName:"Receipt agent",attachments:[{uploadId,storeId:19,uploadCacheId:uploadId,sourceStoreId:19,filename:"receipt.png",mimeType:"image/png",byteSize:12}]};
    const multipart=await submit(control,"SEND",multipartId,body);
    assert.equal((await receipt(control,"SEND",multipartId)).deliveryId,multipart.id);
    await submit(control,"SEND",multipartId,body);
    await tx(clients[0],tenantId,async c=>{
      const rows=(await c.query("SELECT part.id,part.batch_part_count FROM delivery_outbox root JOIN delivery_outbox part ON part.tenant_id=root.tenant_id AND part.batch_id=root.batch_id WHERE root.tenant_id=$1 AND root.id=$2",[tenantId,multipart.id])).rows;
      assert.equal(rows.length,2);assert(rows.every(row=>row.batch_part_count===2));
    });
    await assert.rejects(()=>submit(control,"SEND",multipartId,{...body,message:"Changed"}),error=>error.getStatus()===409);
    const legacyKey=`legacy-native-${randomUUID()}`;
    await control.send("synthetic",legacyKey,groupId,{message:"Legacy native contract",agentDisplayName:"Receipt agent"});
    assert.equal((await control.send("synthetic",legacyKey,groupId,{message:"Legacy native contract",agentDisplayName:"Receipt agent"})).duplicate,true);
    await assert.rejects(()=>controller(clients[1],{actor:{...claims,userId:"877195"}}).send("synthetic",legacyKey,groupId,{message:"Legacy native contract",agentDisplayName:"Receipt agent"}),error=>error.getStatus()===409);
    // Audit evidence is append-only even for admin; seed historical defects at creation.
    const seedHistoricCase=async(kind,requestToken,origin="GROUP_WORKSPACE",change=null)=>{
      const id=randomUUID(),key=`${kind==="SEND"?"group-workspace":"group-workspace-reaction"}:${claims.userId}:${requestToken}`;
      const message="Synthetic group receipt",emoji="✅",reaction=kind==="REACTION";
      const fingerprint=createHash("sha256").update(JSON.stringify(reaction?{groupId,messageId,emoji,removed:false}
        :{groupId,message,replyToMessageId:null,agentDisplayName:"Receipt agent",attachments:[],mentions:[]})).digest("hex");
      await tx(admin,tenantId,async c=>{
        await c.query("INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,state,delivery_origin,reply_to_message_id,request_sha256,agent_display_name,agent_prefix_snapshot,agent_identity_placement_snapshot,zammad_ticket_id,zammad_article_id) VALUES($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$9,$10,$11,'Agent:','OFF',$12,$13)",
          [id,tenantId,connectionId,groupId,reaction?emoji:message,reaction?"application/vnd.wasalx.whatsapp-reaction":"text/plain",key,origin,reaction?`external-${messageId}`:null,fingerprint,reaction?null:"Receipt agent",origin==="TICKET"?"877901":null,origin==="TICKET"?"877902":null]);
        if(change!=="audit_absent")await c.query("INSERT INTO audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id) VALUES($1,'ZAMMAD_USER',$2,$3,$4,$5,$6,$7)",
          [tenantId,change==="audit_actor"?"877195":claims.userId,reaction?"group_workspace.reaction_queued":"group_workspace.message_queued",reaction?"normalized_message":"whatsapp_group",change==="audit_target"?randomUUID():reaction?messageId:groupId,{delivery_id:change==="audit_delivery"?randomUUID():id},`${reaction?"zammad-group-reaction":"zammad-group-send"}:${key}`]);
      });
      return{id,key};
    };
    for(const kind of ["SEND","REACTION"]){
      const requestId=`abcdefab${randomUUID().slice(8)}`,single=await seedHistoricCase(kind,requestId.toUpperCase());
      assert.equal((await receipt(control,kind,requestId)).deliveryId,single.id);
      assert.equal((await submit(control,kind,requestId)).id,single.id);
      const ambiguousId=`abcdefab${randomUUID().slice(8)}`;
      await seedHistoricCase(kind,ambiguousId);await seedHistoricCase(kind,ambiguousId.toUpperCase());
      assert.deepEqual(await receipt(control,kind,ambiguousId,"CANCEL_IF_UNADMITTED"),{outcome:"UNKNOWN",terminal:false});
      await assert.rejects(()=>submit(control,kind,ambiguousId),error=>error.getResponse()?.code==="GROUP_OPERATION_SCOPE_UNKNOWN");
      const conflictingOriginId=`abcdefab${randomUUID().slice(8)}`;
      await seedHistoricCase(kind,conflictingOriginId.toUpperCase(),"TICKET");
      assert.deepEqual(await receipt(control,kind,conflictingOriginId,"CANCEL_IF_UNADMITTED"),{outcome:"UNKNOWN",terminal:false});
      await assert.rejects(()=>submit(control,kind,conflictingOriginId),error=>error.getResponse()?.code==="GROUP_OPERATION_SCOPE_UNKNOWN");
      const historicFenceId=`abcdefab${randomUUID().slice(8)}`,upperKey=`${kind==="SEND"?"group-workspace":"group-workspace-reaction"}:${claims.userId}:${historicFenceId.toUpperCase()}`;
      const insertFence=key=>tx(admin,tenantId,c=>c.query("INSERT INTO group_workspace_operation_receipts(tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id,kind,idempotency_key,target_message_id,disposition) VALUES($1,$2,$3,$4,$5,$6,$7,'CANCELLED')",[tenantId,claims.instanceId,claims.userId,groupId,kind,key,kind==="REACTION"?messageId:null]));
      await insertFence(upperKey);
      await assert.rejects(()=>submit(control,kind,historicFenceId),error=>error.getResponse()?.code==="GROUP_OPERATION_CANCELLED");
      assert.deepEqual(await receipt(control,kind,historicFenceId),{outcome:"NOT_APPLIED",terminal:true});
      await insertFence(groupWorkspaceOperationKey(kind,claims.userId,historicFenceId));
      assert.deepEqual(await receipt(control,kind,historicFenceId,"CANCEL_IF_UNADMITTED"),{outcome:"UNKNOWN",terminal:false});
      await assert.rejects(()=>submit(control,kind,historicFenceId),error=>error.getResponse()?.code==="GROUP_OPERATION_SCOPE_UNKNOWN");
    }
    const opaqueUpper=`Opaque-${randomUUID().toUpperCase()}`,opaqueLower=opaqueUpper.toLowerCase();
    const opaqueA=await control.send("synthetic",opaqueUpper,groupId,{message:"Opaque compatibility",agentDisplayName:"Receipt agent"});
    const opaqueB=await control.send("synthetic",opaqueLower,groupId,{message:"Opaque compatibility",agentDisplayName:"Receipt agent"});assert.notEqual(opaqueA.id,opaqueB.id);
    // Exercise the historical SQL proof itself, not only the service's fingerprint checks.
    const historicalCases=[
      {kind:"SEND",proof:true},{kind:"REACTION",proof:true},
      {kind:"SEND",change:"audit_absent"},{kind:"SEND",change:"audit_actor"},
      {kind:"SEND",change:"audit_target"},{kind:"SEND",change:"audit_delivery"},
      {kind:"SEND",change:"prior_instance"},{kind:"SEND",change:"redacted"},
      {kind:"REACTION",change:"reaction_target"},{kind:"REACTION",change:"source_group"},
    ];
    for(const item of historicalCases){
      const {kind,proof=false,change}=item;
      const requestId=randomUUID(),sent=await seedHistoricCase(kind,requestId,"GROUP_WORKSPACE",change);
      await tx(admin,tenantId,async c=>{
        if(change==="prior_instance")await c.query("UPDATE delivery_outbox delivery SET created_at=instance.created_at-interval '1 second' FROM zammad_instances instance WHERE delivery.tenant_id=$1 AND delivery.id=$2 AND instance.tenant_id=delivery.tenant_id",[tenantId,sent.id]);
        if(change==="redacted")await c.query("UPDATE delivery_outbox SET state='PRIVACY_CANCELLED',content_redacted_at=now(),group_workspace_group_id=NULL,message_body='',content_type='text/plain',mentions='{}',reply_to_message_id=NULL,agent_display_name=NULL,agent_prefix_snapshot=NULL,agent_identity_placement_snapshot=NULL,manual_retry_allowed=false,blocked_by_delivery_id=NULL,external_message_id=NULL,lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",[tenantId,sent.id]);
        if(change==="reaction_target")await c.query("UPDATE delivery_outbox SET reply_to_message_id='unrelated-target' WHERE tenant_id=$1 AND id=$2",[tenantId,sent.id]);
        if(change==="source_group")await c.query("UPDATE normalized_messages SET external_group_id='fixture-0025@example.test' WHERE tenant_id=$1 AND id=$2",[tenantId,messageId]);
      });
      try{
        const recovered=await receipt(control,kind,requestId,"CANCEL_IF_UNADMITTED");
        assert.equal(recovered.outcome,proof?"ADMITTED":"UNKNOWN",`${kind}:${change??"valid"}`);if(proof)assert.equal(recovered.deliveryId,sent.id);
        else await assert.rejects(()=>submit(control,kind,requestId),error=>error.getResponse()?.code==="GROUP_OPERATION_SCOPE_UNKNOWN");
      }finally{if(change==="source_group")await tx(admin,tenantId,c=>c.query("UPDATE normalized_messages SET external_group_id=$3 WHERE tenant_id=$1 AND id=$2",[tenantId,messageId,externalGroup]));}
    }
    const retainedRequest=randomUUID(),retained=await submit(control,"SEND",retainedRequest);
    await tx(admin,tenantId,c=>c.query("UPDATE delivery_outbox SET state='PRIVACY_CANCELLED',content_redacted_at=now(),group_workspace_group_id=NULL,message_body='',content_type='text/plain',mentions='{}',reply_to_message_id=NULL,agent_display_name=NULL,agent_prefix_snapshot=NULL,agent_identity_placement_snapshot=NULL,manual_retry_allowed=false,blocked_by_delivery_id=NULL,external_message_id=NULL,lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",[tenantId,retained.id]));
    assert.deepEqual(await receipt(control,"SEND",retainedRequest,"CANCEL_IF_UNADMITTED"),{outcome:"ADMITTED",terminal:true,deliveryId:retained.id,state:"PRIVACY_CANCELLED"});
    assert.equal((await submit(control,"SEND",retainedRequest)).duplicate,true);
    await assert.rejects(()=>tx(admin,tenantId,c=>c.query("DELETE FROM delivery_outbox WHERE tenant_id=$1 AND id=$2",[tenantId,retained.id])),error=>error.code==="23503");
    // A grant change during the advisory wait must be read after acquiring that lock.
    const revokeId=randomUUID(),revokeKey=groupWorkspaceOperationKey("SEND",claims.userId,revokeId);
    await clients[0].query("BEGIN");await clients[0].query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`group-workspace-operation:${tenantId}:${revokeKey}`]);
    const revoked=receipt(controller(clients[1]),"SEND",revokeId,"CANCEL_IF_UNADMITTED").then(value=>({value}),error=>({error}));
    try{await overlap(pids[0],pids[1]);await tx(admin,tenantId,c=>c.query("UPDATE group_workspace_settings SET visibility='RESTRICTED' WHERE tenant_id=$1 AND whatsapp_group_id=$2",[tenantId,groupId]));}finally{await clients[0].query("COMMIT");}
    assert.equal((await revoked).error?.getStatus(),404);
    await tx(admin,tenantId,c=>c.query("UPDATE group_workspace_settings SET visibility='ALL_AGENTS' WHERE tenant_id=$1 AND whatsapp_group_id=$2",[tenantId,groupId]));
    // Restoring authority must preserve the monotonically increasing projection revision.
    let managedRevision=4;
    for(const changed of ["membership","subject","email","native_sync","expiry"]){
      const actor=changed==="expiry"?{...claims,expiresAt:Math.floor(Date.now()/1000)+2}:{...claims,userId:"877194",membershipRevision:managedRevision};
      const requestId=randomUUID(),key=groupWorkspaceOperationKey("SEND",actor.userId,requestId);
      await clients[0].query("BEGIN");await clients[0].query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`group-workspace-operation:${tenantId}:${key}`]);
      const waiting=receipt(controller(clients[1],{actor}),"SEND",requestId,"CANCEL_IF_UNADMITTED").then(value=>({value}),error=>({error}));
      try{
        await overlap(pids[0],pids[1]);
        if(changed==="membership"){managedRevision++;await tx(admin,tenantId,c=>c.query("UPDATE native_membership_projections SET revision=$3,applied_revision=$3 WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId,managedRevision]));}
        else if(changed==="subject")await tx(admin,tenantId,c=>c.query("UPDATE users SET oidc_subject=$2 WHERE id=$1",[userId,`drift-${userId}`]));
        else if(changed==="email")await tx(admin,tenantId,c=>c.query("UPDATE users SET email=$2 WHERE id=$1",[userId,`drift-${userId}@example.invalid`]));
        else if(changed==="native_sync")await tx(admin,tenantId,c=>c.query("UPDATE tenant_settings SET native_membership_sync_enabled=false WHERE tenant_id=$1",[tenantId]));
        else await admin.query("SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))+0.05)",[actor.expiresAt]);
      }finally{await clients[0].query("COMMIT");}
      assert.equal((await waiting).error?.getStatus(),401,`stale ${changed} passed after advisory wait`);
      await tx(admin,tenantId,async c=>{
        await c.query("UPDATE users SET oidc_subject=$2,email=$3 WHERE id=$1",[userId,`receipt-${userId}`,`receipt-${userId}@example.invalid`]);
        await c.query("UPDATE native_membership_projections SET revision=$3,applied_revision=$3 WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId,managedRevision]);
        await c.query("UPDATE tenant_settings SET native_membership_sync_enabled=true WHERE tenant_id=$1",[tenantId]);
      });
    }
    const ownCount=(await read("SELECT count(*)::int n FROM group_workspace_operation_receipts WHERE tenant_id=$1 AND whatsapp_group_id=$2")).rows[0].n;assert(ownCount>0);
    assert.equal((await tx(clients[0],foreignTenant,c=>c.query("SELECT count(*)::int n FROM group_workspace_operation_receipts WHERE tenant_id=$1 AND whatsapp_group_id=$2",[tenantId,groupId]))).rows[0].n,0);
    for(const action of ["UPDATE","DELETE"]){
      await assert.rejects(()=>tx(clients[0],tenantId,c=>c.query(action==="UPDATE"?"UPDATE group_workspace_operation_receipts SET disposition='CANCELLED' WHERE tenant_id=$1":"DELETE FROM group_workspace_operation_receipts WHERE tenant_id=$1",[tenantId])),error=>error.code==="42501");
    }
    const foreignInstance=(await tx(admin,foreignTenant,c=>c.query("SELECT id FROM zammad_instances WHERE tenant_id=$1",[foreignTenant]))).rows[0].id;
    await assert.rejects(()=>tx(clients[0],tenantId,c=>c.query("INSERT INTO group_workspace_operation_receipts(tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id,kind,idempotency_key,disposition) VALUES($1,$2,'877193',$3,'SEND',$4,'CANCELLED')",[tenantId,foreignInstance,groupId,`foreign-instance-${randomUUID()}`])),error=>error.code==="23503");
    assert(lastAlias);assert(lastReceiptAlias);
    await tx(clients[0],tenantId,async c=>{
      await c.query("SET LOCAL enable_seqscan=off");
      const plan=(await c.query(`EXPLAIN (FORMAT JSON) ${lastAlias.sql}`,lastAlias.values)).rows;
      assert(JSON.stringify(plan).includes("delivery_outbox_group_workspace_uuid_key_idx"),"Native alias lookup cannot use its bounded expression index");
      const receiptPlan=(await c.query(`EXPLAIN (FORMAT JSON) ${lastReceiptAlias.sql}`,lastReceiptAlias.values)).rows;
      assert(JSON.stringify(receiptPlan).includes("group_workspace_operation_receipts_uuid_key_idx"),"Receipt alias lookup cannot use its bounded expression index");
    });
    console.log(JSON.stringify({kind:"postgres-group-operation-receipts",evidenceMode:"simulated",raceOrderings:8,casing:["upper-to-lower","lower-to-upper"],legacyCaseProofs:8,rollbackCases:4,historicalCases:historicalCases.length,afterLockChanges:["grant","membership","subject","email","native_sync","expiry"],retainedAdmission:true,multipartParts:2,scope:"control admission only; provider delivery unqualified"}));
  }catch(error){primary=error;throw error;}finally{
    const cleanup=[];
    for(const c of connected){try{await c.query("ROLLBACK");await c.end();}catch(error){cleanup.push(error);}}
    if(owned)try{await tx(admin,tenantId,async c=>{
      // Immutable synthetic audit evidence remains until the disposable database is destroyed.
      await c.query("DELETE FROM group_workspace_operation_receipts WHERE tenant_id=$1 AND whatsapp_group_id=$2",[tenantId,groupId]);
      await c.query("DELETE FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2",[tenantId,connectionId]);
      await c.query("DELETE FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId]);
      await c.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId]);
      // Membership lifecycle may retain a REMOVED projection while sync is enabled.
      await c.query("DELETE FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId]);
      await c.query("DELETE FROM users WHERE id=$1",[userId]);
      await c.query("DELETE FROM connections WHERE tenant_id=$1 AND id=$2",[tenantId,connectionId]);
      await c.query("UPDATE tenant_settings SET group_workspace_enabled=$2,native_membership_sync_enabled=$3 WHERE tenant_id=$1",[tenantId,previousEnabled,previousNativeEnabled]);
      assert.equal((await c.query("SELECT count(*)::int n FROM connections WHERE tenant_id=$1 AND id=$2",[tenantId,connectionId])).rows[0].n,0);
    });}catch(error){cleanup.push(error);}
    // eslint-disable-next-line no-unsafe-finally -- Cleanup failure must fail an otherwise passing disposable gate.
    if(cleanup.length){if(primary)primary.cleanupFailed=true;else throw new AggregateError(cleanup,"Group receipt fixture cleanup failed");}
  }
}
