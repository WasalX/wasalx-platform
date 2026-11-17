import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {verifyQuarantineConflictIndex} from './quarantine-real-schema-check.mjs';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {ZammadGroupWorkspaceController} from '../services/control-api/dist/group-workspace.controller.js';

// Integrate beside verifyGroupQuoteProjection in the existing isolated PG gate.
// Fixture transaction is always rolled back; never call against live admission.
export async function verifyParticipantIdentityProjection(client,tenantId){
 const connectionId=randomUUID(),foreignConnection=randomUUID(),groupId=randomUUID(),externalGroup='120363000000987@g.us',participant='12025550180@c.us';
 const claims={tenantId,userId:'77',groupIds:[],groupAdmin:true,instanceId:'11000000-0000-4000-8000-000000000001',subject:'11000000-0000-4000-8000-000000000001'};
 await client.query('BEGIN');
 try{
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  for(const [role,table,permission] of [['wasalx_connector_worker','normalized_messages','INSERT'],['wasalx_connector_worker','participant_identities','INSERT'],['wasalx_connector_worker','group_workspace_settings','SELECT'],['wasalx_app','participant_identities','SELECT']])assert.equal((await client.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,table,permission])).rows[0].allowed,true,`${role} ${table} ${permission}`);
  for(const column of ['display_name','display_name_quality','normalized_phone'])assert.equal((await client.query("SELECT has_column_privilege('wasalx_connector_worker','participant_identities',$1,'UPDATE') AS allowed",[column])).rows[0].allowed,true);
  for(const id of [connectionId,foreignConnection])await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Identity fixture','WAHA','GOWS','WORKING',$3)",[id,tenantId,`secret://${tenantId}/connections/${id}/waha`]);
  await client.query('UPDATE tenant_settings SET group_workspace_enabled=true WHERE tenant_id=$1',[tenantId]);
  await client.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Identity fixture')",[groupId,tenantId,connectionId,externalGroup]);
  await client.query("INSERT INTO group_workspace_settings(tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by) VALUES($1,$2,true,now()-interval '1 day',30,'ALL_AGENTS','10100000-0000-4000-8000-000000000001')",[tenantId,groupId]);
  await client.query("INSERT INTO participant_identities(tenant_id,connection_id,external_participant_id,display_name,display_name_quality) VALUES($1,$2,$3,'Foreign name',3)",[tenantId,foreignConnection,participant]);
  const repository=new InboundRepository({});
  // Bind repository transactions to this rollback fixture, retaining actual
  // worker role, tenant and all production normalize/upsert SQL.
  repository.tenant=async(scope,fn)=>{assert.equal(scope,tenantId);await client.query('SET LOCAL ROLE wasalx_connector_worker');try{return await fn(client)}finally{await client.query('RESET ROLE')}};
  const controller=new ZammadGroupWorkspaceController({rows:async(scope,sql,args)=>{assert.equal(scope,tenantId);await client.query('SET LOCAL ROLE wasalx_app');try{return(await client.query(sql,args)).rows}finally{await client.query('RESET ROLE')}}} ,{verify:async()=>claims},{});
  const created=[];let retainedEvent;
  for(const name of ['Initial Name','Renamed Name','', '123456789@lid']){
   const id=randomUUID(),messageId=`identity-${id}`;
   await client.query("INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES($1,$2,$3,'WAHA',$4,'message','{}',$5,'PROCESSING')",[id,tenantId,connectionId,messageId,createHash('sha256').update('{}').digest('hex')]);
   const event={id,tenantId,connectionId,provider:'waha',providerEventId:messageId,eventType:'message',payload:{},attempts:0};retainedEvent=event;
   const message={provider:'waha',connectionId,eventId:messageId,messageId,groupId:externalGroup,participantId:participant,participantName:name,text:'No reference here',fromApi:false,fromMe:false,timestamp:new Date().toISOString()};
   assert.equal(await repository.normalize(event,message,true),'new');
   const row=(await client.query('SELECT id FROM normalized_messages WHERE tenant_id=$1 AND event_inbox_id=$2',[tenantId,id])).rows[0];created.push(row.id);
   const expected=name==='Initial Name'?'Initial Name':'Renamed Name';
   assert.equal((await client.query('SELECT display_name FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3',[tenantId,connectionId,participant])).rows[0].display_name,expected);
   for(const rows of [await controller.messages('fixture',groupId,undefined,'100'),await controller.context('fixture',groupId,row.id)])assert.equal(rows.find(x=>x.id===row.id)?.participant_name,expected);
   assert.equal((await controller.source('fixture',groupId,row.id)).participant_name,expected);
  }
  assert.equal((await client.query('SELECT display_name FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3',[tenantId,foreignConnection,participant])).rows[0].display_name,'Foreign name');
  assert.equal((await client.query("SELECT count(*)::int AS count FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND provider_metadata ? 'zammad_customer_id'",[tenantId,connectionId])).rows[0].count,0,'captured no-ticket path alone retained identity');
  await client.query('UPDATE group_workspace_settings SET capture_enabled=false WHERE tenant_id=$1 AND whatsapp_group_id=$2',[tenantId,groupId]);
  await assert.rejects(()=>controller.messages('fixture',groupId,undefined,'100'));
  await client.query('SET LOCAL ROLE wasalx_connector_worker');
  let quarantine;try{quarantine=await verifyQuarantineConflictIndex({InboundRepository,client,event:retainedEvent})}finally{await client.query('RESET ROLE')}
  return {transitions:4,readPaths:3,crossConnection:true,captureDenial:true,noTicketRequired:true,quarantine};
 }finally{await client.query('ROLLBACK')}
}
