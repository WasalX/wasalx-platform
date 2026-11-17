import type { PoolClient } from "pg";
import { parseBotFlow } from "@wasalx/core/bot-flow";
import { parseClientRouting } from "@wasalx/core/client-routing";
import { canonicalNativeRoutingManifest, type DepartmentDefaultPolicy, type NativeRoutingManifest } from "@wasalx/core/native-routing-contract";

export async function buildNativeRoutingManifest(client:PoolClient,tenantId:string,defaults:DepartmentDefaultPolicy[]):Promise<NativeRoutingManifest>{
  const groups=new Map<string,Set<string>>();
  const reference=(id:string,owner?:string|null)=>{const owners=groups.get(id)??new Set<string>();if(owner)owners.add(owner);groups.set(id,owners);};
  const assignments:NativeRoutingManifest["assignments"]=[];
  const bindings=(await client.query<{id:string;revision:string|number;zammad_group_id:string;assignment_mode:string;fixed_owner_id:string|null}>(`SELECT b.id,b.revision,b.zammad_group_id,b.assignment_mode,b.fixed_owner_id
    FROM group_bindings b JOIN whatsapp_groups g ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id
    JOIN connections c ON c.tenant_id=g.tenant_id AND c.id=g.connection_id
    WHERE b.tenant_id=$1 AND b.state='ACTIVE' AND c.state<>'REVOKED'`,[tenantId])).rows;
  for(const binding of bindings){
    const owner=binding.assignment_mode==="fixed_owner"?binding.fixed_owner_id:null;
    reference(binding.zammad_group_id,owner);
    assignments.push({key:`group-binding:${binding.id}`,source_kind:"GROUP_BINDING",source_id:binding.id,source_revision:String(binding.revision),group_id:binding.zammad_group_id,owner_id:owner});
  }
  const flows=(await client.query<{id:string;revision:string|number;flow_version_id:string;zammad_group_id:string;definition:unknown}>(`SELECT a.id,a.revision,a.flow_version_id,a.zammad_group_id,v.definition
    FROM bot_assignments a JOIN bot_flow_versions v ON v.tenant_id=a.tenant_id AND v.id=a.flow_version_id AND v.state='ACTIVE'
    JOIN connections c ON c.tenant_id=a.tenant_id AND c.id=a.connection_id
    WHERE a.tenant_id=$1 AND a.state='ACTIVE' AND c.state<>'REVOKED'`,[tenantId])).rows;
  for(const flow of flows){
    reference(flow.zammad_group_id);
    for(const node of parseBotFlow(flow.definition).nodes)if(node.type==="handoff"&&node.target==="FIXED"){
      reference(node.zammadGroupId,node.zammadOwnerId);
      const sourceId=`${flow.id}:${flow.flow_version_id}:${node.id}`;
      assignments.push({key:`bot-handoff:${sourceId}`,source_kind:"BOT_HANDOFF",source_id:sourceId,source_revision:String(flow.revision),group_id:node.zammadGroupId,owner_id:node.zammadOwnerId??null});
    }
  }
  const active=(await client.query<{id:string;snapshot_sha256:string;definition:unknown}>("SELECT id,snapshot_sha256,definition FROM client_routing_versions WHERE tenant_id=$1 AND state='ACTIVE'",[tenantId])).rows[0];
  let clientRouting:NativeRoutingManifest["client_routing"]=null;
  if(active){
    const routing=parseClientRouting(active.definition);
    reference(routing.fallback.zammadGroupId,routing.fallback.ownerId);
    for(const entry of routing.clients){reference(entry.zammadGroupId,entry.ownerId);if(entry.escalationGroupId)reference(entry.escalationGroupId,entry.escalationOwnerId);}
    for(const id of routing.supportGroupIds??[])reference(id);
    clientRouting={version_id:active.id,snapshot_sha256:active.snapshot_sha256,support_group_ids:routing.supportGroupIds??[]};
  }
  for(const policy of defaults)if(policy.enabled)reference(policy.zammadGroupId,policy.zammadOwnerId);
  return canonicalNativeRoutingManifest({group_references:[...groups].map(([group_id,owners])=>({group_id,owner_ids:[...owners]})),assignments,
    department_defaults:defaults.map(policy=>({key:policy.id,group_id:policy.zammadGroupId,owner_id:policy.zammadOwnerId,enabled:policy.enabled})),client_routing:clientRouting});
}
