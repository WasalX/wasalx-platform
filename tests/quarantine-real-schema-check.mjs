import assert from 'node:assert/strict';
// Run inside an existing rollback-only fixture transaction with a real migrated event.
// Suppress only nested transaction management; all repository SQL reaches actual PostgreSQL.
export async function verifyQuarantineConflictIndex({InboundRepository,client,event}){
 const repository=new InboundRepository({connect:async()=>({release(){},query:async(sql,values)=>{
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[],rowCount:0};
  return client.query(sql,values);
 }})});
 const input={reasonCode:'IDENTIFIER_LIMIT_EXCEEDED',safeSummary:'Regression bounded reference limit'};
 const first=await repository.quarantineInbound(event,input);const second=await repository.quarantineInbound(event,input);assert.equal(first,second);
 const rows=await client.query('SELECT id FROM quarantine_records WHERE tenant_id=$1 AND source_event_inbox_id=$2 AND group_action_execution_id IS NULL',[event.tenantId,event.id]);assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].id,first);
 return{passed:1,rollbackRequired:true};
}
