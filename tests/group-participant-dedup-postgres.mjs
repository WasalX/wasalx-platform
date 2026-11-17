import assert from "node:assert/strict";
import { ZammadGroupWorkspaceController } from "../services/control-api/dist/group-workspace.controller.js";
import { GroupsController } from "../services/control-api/dist/groups.controller.js";
import { synchronizeGroups } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js";

export async function verifyGroupParticipantDedup(client,tenantId) {
  const groupId="13900000-0000-4000-8000-000000000097",otherGroupId="13900000-0000-4000-8000-000000000096",connectionId="12900000-0000-4000-8000-000000000097";
  const claims={tenantId,userId:"77",groupIds:[],groupAdmin:true,instanceId:"11000000-0000-4000-8000-000000000001"};
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Participant dedup','WAHA','GOWS','WORKING',$3)",[connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/waha`]);
    await client.query("UPDATE tenant_settings SET group_workspace_enabled=true WHERE tenant_id=$1",[tenantId]);
    for(const [id,external,name] of [[groupId,"120363000000097@g.us","Participant dedup"],[otherGroupId,"120363000000096@g.us","Other participant group"]]){
      await client.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,$5)",[id,tenantId,connectionId,external,name]);
      await client.query("INSERT INTO group_workspace_settings(tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by) VALUES($1,$2,true,now()-interval '1 day',30,'ALL_AGENTS','10100000-0000-4000-8000-000000000001')",[tenantId,id]);
    }
    await client.query(`INSERT INTO group_workspace_participants
      (tenant_id,whatsapp_group_id,external_participant_id,display_name,normalized_phone,synchronized_at) VALUES
      ($1,$2,'12025550108@c.us',NULL,'12025550108',now()),
      ($1,$2,'12025550109@lid','Alias roster name','12025550108',now()),
      ($1,$2,'12025550110@lid','Unrelated participant',NULL,now()),
      ($1,$3,'12025550108@c.us','Foreign group alias','12025550108',now())`,[tenantId,groupId,otherGroupId]);
    await client.query("UPDATE whatsapp_groups SET participant_count=12 WHERE tenant_id=$1 AND id=$2",[tenantId,groupId]);
    assert.deepEqual((await client.query("SELECT participant_count,participant_count_known FROM whatsapp_groups WHERE tenant_id=$1 AND id=$2",[tenantId,groupId])).rows,[{participant_count:12,participant_count_known:true}],"legacy/default counts retain their normal semantics");
    const database={withTenant:async(scope,work)=>{
      assert.equal(scope,tenantId);await client.query("SET LOCAL ROLE wasalx_app");
      try{return await work(client)}finally{await client.query("RESET ROLE")}
    },rows:async(scope,sql,params)=>database.withTenant(scope,async scopedClient=>(await scopedClient.query(sql,params)).rows)};
    const controller=new ZammadGroupWorkspaceController(database,{verify:async()=>claims},{});
    const portal=new GroupsController(database,{verifySelection:async()=>[]});
    const request={id:"count-provenance",principal:{tenantId,userId:"10100000-0000-4000-8000-000000000001",role:"tenant_owner"}};
    assert.deepEqual(await controller.participants("test",groupId,"Alias roster"),[{id:"12025550108@c.us",name:"Alias roster name",phone:"12025550108"}],"an alias search returns the canonical linked PN without dropping the known alias name");
    await client.query("UPDATE group_workspace_participants SET display_name='Canonical PN' WHERE tenant_id=$1 AND whatsapp_group_id=$2 AND external_participant_id='12025550108@c.us'",[tenantId,groupId]);
    assert.deepEqual(await controller.participants("test",groupId,"Alias roster"),[{id:"12025550108@c.us",name:"Canonical PN",phone:"12025550108"}],"alias search remains valid when the canonical PN has its own name");
    assert.deepEqual(await controller.participants("test",groupId,""),[
      {id:"12025550108@c.us",name:"Canonical PN",phone:"12025550108"},
      {id:"12025550110@lid",name:"Unrelated participant",phone:null},
    ],"only an explicit normalized-phone link is deduplicated inside the selected group");
    const beforeParticipants=(await client.query("SELECT to_jsonb(participant) AS record FROM group_workspace_participants participant WHERE tenant_id=$1 ORDER BY whatsapp_group_id,external_participant_id",[tenantId])).rows;
    const beforeForeign=(await client.query("SELECT to_jsonb(group_record) AS record FROM whatsapp_groups group_record WHERE tenant_id=$1 AND id=$2",[tenantId,otherGroupId])).rows;
    const previous=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;
    process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify(["120363000000097@g.us"]);
    try {
      await synchronizeGroups(client,{tenantId,connectionId,provider:"WAHA"},[{id:"120363000000097@g.us",name:"Selected metadata only",participants:0}]);
      assert.deepEqual((await client.query("SELECT to_jsonb(group_record) AS record FROM whatsapp_groups group_record WHERE tenant_id=$1 AND id=$2",[tenantId,otherGroupId])).rows,beforeForeign,"scoped synchronization preserves the complete excluded group row");
      assert.deepEqual((await client.query("SELECT to_jsonb(participant) AS record FROM group_workspace_participants participant WHERE tenant_id=$1 ORDER BY whatsapp_group_id,external_participant_id",[tenantId])).rows,beforeParticipants,"scoped synchronization preserves every selected and excluded participant row");
      assert.equal((await client.query("SELECT display_name FROM whatsapp_groups WHERE tenant_id=$1 AND id=$2",[tenantId,groupId])).rows[0].display_name,"Selected metadata only");
      assert.deepEqual((await client.query("SELECT participant_count,participant_count_known FROM whatsapp_groups WHERE tenant_id=$1 AND id=$2",[tenantId,groupId])).rows,[{participant_count:12,participant_count_known:false}],"metadata-only discovery preserves the old number without presenting it as current");
      assert.equal((await portal.detail(request,groupId)).participant_count,null);
      assert.equal((await portal.list(request,undefined,"50",undefined,connectionId)).find(group=>group.id===groupId).participant_count,null);
      assert.equal((await controller.groups("test")).items.find(group=>group.id===groupId).participant_count,null,"the native workspace also receives unknown instead of the old number");
      await assert.rejects(synchronizeGroups(client,{tenantId,connectionId,provider:"WAHA"},[{id:"120363000000096@g.us",name:"Excluded update",participants:0}]),{code:"WAHA_TEST_RECIPIENT_NOT_ALLOWED"});
      assert.deepEqual((await client.query("SELECT to_jsonb(group_record) AS record FROM whatsapp_groups group_record WHERE tenant_id=$1 AND id=$2",[tenantId,otherGroupId])).rows,beforeForeign);
      process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify(["120363000000097@g.us","120363000000095@g.us"]);
      const metadata=[{id:"120363000000097@g.us",name:"Selected metadata only",participants:99},{id:"120363000000095@g.us",name:"New metadata only",participants:0}];
      await synchronizeGroups(client,{tenantId,connectionId,provider:"WAHA"},metadata);
      await synchronizeGroups(client,{tenantId,connectionId,provider:"WAHA"},metadata);
      assert.deepEqual((await client.query("SELECT external_group_id,participant_count,participant_count_known FROM whatsapp_groups WHERE tenant_id=$1 AND connection_id=$2 AND external_group_id=ANY($3::text[]) ORDER BY external_group_id",[tenantId,connectionId,metadata.map(group=>group.id)])).rows,[
        {external_group_id:"120363000000095@g.us",participant_count:0,participant_count_known:false},
        {external_group_id:"120363000000097@g.us",participant_count:12,participant_count_known:false},
      ],"new and repeated scoped metadata never converts zero or a positive declaration into a known count");
      assert.deepEqual((await client.query("SELECT to_jsonb(group_record) AS record FROM whatsapp_groups group_record WHERE tenant_id=$1 AND id=$2",[tenantId,otherGroupId])).rows,beforeForeign);
      assert.deepEqual((await client.query("SELECT to_jsonb(participant) AS record FROM group_workspace_participants participant WHERE tenant_id=$1 ORDER BY whatsapp_group_id,external_participant_id",[tenantId])).rows,beforeParticipants);
      process.env.WASALX_TEST_RECIPIENT_ALLOWLIST="*";
      for(const count of [7,0]){
        await synchronizeGroups(client,{tenantId,connectionId,provider:"WAHA"},[{id:"120363000000097@g.us",name:"Normal snapshot",participants:count}]);
        assert.deepEqual((await client.query("SELECT participant_count,participant_count_known FROM whatsapp_groups WHERE tenant_id=$1 AND id=$2",[tenantId,groupId])).rows,[{participant_count:count,participant_count_known:true}]);
        assert.equal((await portal.detail(request,groupId)).participant_count,count,"normal positive and legitimate empty counts remain visible");
      }
    } finally {
      if(previous===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=previous;
    }
  } finally { await client.query("ROLLBACK"); }
}
