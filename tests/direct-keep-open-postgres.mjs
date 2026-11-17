import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { tryLockDirectConversation, assertDirectNativeBarrier, resetDirectHumanPauseForCompletedBatch } from '../packages/core/dist/direct-keep-open.js';
import { prepareDirectCustomerClose, directCustomerCloseAdmission, recordDirectCloseReceipt } from '../packages/core/dist/direct-customer-close.js';
import { reserveDirectNativeReply, admitDirectReplyIntent, completeDirectReplyIntent } from '../services/control-api/dist/direct-native-operations.js';
import { ZammadTicketStateController } from '../services/control-api/dist/zammad-ticket-state.controller.js';
import { OutboxRepository } from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import { InboundRepository } from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import { inspectDirectWelcomeResendInput, inspectDirectKeepOpenInput } from '../services/connector-worker/dist/services/connector-worker/src/direct-keep-open-runtime.js';

// Actual PostgreSQL only. The canonical harness supplies its isolated test DB;
// this helper creates synthetic records in one transaction and rolls them back.
export async function verifyDirectKeepOpenConstraints(client, tenantId, fixture) {
  const { foreignTenantId, botAssignmentId, botFlowVersionId, userId, adminUrl, existingConversationId } = fixture;
  assert(tenantId && foreignTenantId && botAssignmentId && botFlowVersionId && userId && adminUrl && existingConversationId);
  const tables = ['direct_native_reply_intents', 'direct_customer_close_commands'];
  const checks = [];
  let serial = 0;
  const prefix = `direct-keep-open-pg-${randomUUID()}`;
  const conversationId = randomUUID(), closeConversationId = randomUUID();
  const nativeId = randomUUID(), commandId = randomUUID();
  const hash = 'a'.repeat(64);
  const check = async (name, action) => { await action(); checks.push(name); };
  const scoped = async (scope, role, action) => {
    assert(['wasalx_app', 'wasalx_connector_worker'].includes(role));
    const savepoint = `direct_keep_open_role_${++serial}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope]);
      await client.query(`SET LOCAL ROLE ${role}`);
      const result = await action();
      await client.query('RESET ROLE');
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  };
  const app = action => scoped(tenantId, 'wasalx_app', action);
  const worker = action => scoped(tenantId, 'wasalx_connector_worker', action);
  const trial = async action => {
    const savepoint = `direct_keep_open_trial_${++serial}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try { return await action(); }
    finally { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`); }
  };
  const rejects = (name, code, action, constraint) => check(name, () => trial(() => assert.rejects(action,
    error => error.code === code && (!constraint || error.constraint === constraint), name)));
  const insert = (table, row) => {
    assert(tables.includes(table));
    const columns = Object.keys(row);
    assert(columns.every(column => /^[a-z_][a-z0-9_]*$/u.test(column)));
    return client.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  };
  const update = (table, id, changes) => {
    assert(tables.includes(table));
    const columns = Object.keys(changes);
    assert(columns.every(column => /^[a-z_][a-z0-9_]*$/u.test(column)));
    return client.query(`UPDATE ${table} SET ${columns.map((column, i) => `${column}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...Object.values(changes)]);
  };
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const assignment = (await client.query('SELECT connection_id FROM bot_assignments WHERE tenant_id=$1 AND id=$2', [tenantId, botAssignmentId])).rows[0];
    assert(assignment, 'canonical bot assignment prerequisite');
    const connectionId = assignment.connection_id;
    const foreignConnectionId = (await client.query('SELECT id FROM connections WHERE tenant_id=$1 ORDER BY id LIMIT 1', [foreignTenantId])).rows[0]?.id;
    const instanceId = (await client.query('SELECT id FROM zammad_instances WHERE tenant_id=$1 ORDER BY id LIMIT 1', [tenantId])).rows[0]?.id;
    const foreignInstanceId = (await client.query('SELECT id FROM zammad_instances WHERE tenant_id=$1 ORDER BY id LIMIT 1', [foreignTenantId])).rows[0]?.id;
    assert(foreignConnectionId && instanceId && foreignInstanceId, 'canonical tenant fixtures');
    const conversation = async (id, suffix, {assignmentId=botAssignmentId,assignedConnectionId=connectionId,versionId=botFlowVersionId,ticketId='98501'}={}) => client.query(`INSERT INTO bot_conversations
      (id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,last_activity_at,
       normalized_reference,zammad_ticket_id,zammad_ticket_number,human_ownership_epoch,fencing_token,zammad_customer_id)
      VALUES($1,$2,$3,$4,$5,$6,'HUMAN','hello',now(),$7,$8,$8,2,7,77)`,
      [id,tenantId,assignmentId,assignedConnectionId,versionId,`${prefix}-${suffix}@c.us`,`BOT-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`,ticketId]);
    await conversation(conversationId, 'native'); await conversation(closeConversationId, 'close');
    const event = async (scope, connection) => {
      const id = randomUUID();
      await client.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
        VALUES($1,$2,$3,'WAHA',$4,'message','{}',$5,'PROCESSED')`, [id,scope,connection,`${prefix}-${id}`,hash]);
      return id;
    };
    const requestEventId = await event(tenantId, connectionId), confirmationEventId = await event(tenantId, connectionId);
    const nextConfirmationEventId = await event(tenantId, connectionId), foreignEventId = await event(foreignTenantId, foreignConnectionId);
    const promptDeliveryId = randomUUID(), foreignDeliveryId = randomUUID();
    await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,
      zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,delivery_origin,direct_origin,direct_ownership_epoch)
      VALUES($1,$2,$3,$4,$5,'98501','985011','Synthetic close prompt','text/plain',$6,'SENT','TICKET','BOT',2)`,
      [promptDeliveryId,tenantId,connectionId,closeConversationId,`${prefix}fixture-0021@example.test`,`${prefix}-prompt`]);
    await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,message_body,content_type,idempotency_key,state,
      delivery_origin,content_redacted_at,agent_identity_placement_snapshot,manual_retry_allowed)
      VALUES($1,$2,$3,'','text/plain',$4,'SENT','TICKET',now(),NULL,false)`,
      [foreignDeliveryId,foreignTenantId,foreignConnectionId,`${prefix}-foreign`]);
    const native = overrides => ({id:randomUUID(),tenant_id:tenantId,conversation_id:conversationId,instance_id:instanceId,
      native_ticket_id:'98501',native_actor_id:'77',human_ownership_epoch:2,request_sha256:hash,...overrides});
    const command = overrides => ({id:randomUUID(),tenant_id:tenantId,conversation_id:closeConversationId,request_event_id:requestEventId,
      confirmation_event_id:confirmationEventId,confirmation_prompt_delivery_id:promptDeliveryId,human_ownership_epoch:2,
      conversation_fencing_token:7,request_sha256:hash,...overrides});
    const fkName = async (table, column) => {
      const result = await client.query(`SELECT constraint_row.conname FROM pg_constraint constraint_row
        JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=ANY(constraint_row.conkey)
        WHERE constraint_row.conrelid=$1::regclass AND constraint_row.contype='f' AND attribute.attname=$2`, [table,column]);
      assert.equal(result.rowCount,1,`${table}.${column} tenant FK`); return result.rows[0].conname;
    };

    for (const table of tables) {
      await check(`${table}: RLS forced and least privilege`, async () => {
        const row=(await client.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass`,[table])).rows[0];
        assert.deepEqual(row,{relrowsecurity:true,relforcerowsecurity:true});
        for (const role of ['wasalx_app','wasalx_connector_worker']) {
          const privilege=(await client.query(`SELECT has_table_privilege($1,$2,'SELECT') AS read,
            has_table_privilege($1,$2,'INSERT') AS insert,has_table_privilege($1,$2,'UPDATE') AS update,
            has_table_privilege($1,$2,'DELETE') AS delete`,[role,table])).rows[0];
          const canWrite=role==='wasalx_app'||table==='direct_customer_close_commands';
          const canDelete=role==='wasalx_connector_worker'&&table==='direct_customer_close_commands';
          assert.deepEqual(privilege,{read:true,insert:canWrite,update:canWrite,delete:canDelete});
        }
      });
    }
    for (const [column,value] of [['instance_id',foreignInstanceId],['delivery_id',foreignDeliveryId]]) {
      const extra=column==='delivery_id'?{state:'ADMITTED',native_article_id:'985012',completed_at:new Date()}:{};
      await rejects(`native: foreign ${column}`,'23503',()=>app(()=>insert(tables[0],native({...extra,[column]:value}))),await fkName(tables[0],column));
    }
    await rejects('native: foreign conversation','23503',()=>scoped(foreignTenantId,'wasalx_app',()=>insert(tables[0],
      native({tenant_id:foreignTenantId,instance_id:foreignInstanceId}))),await fkName(tables[0],'conversation_id'));
    for (const column of ['request_event_id','confirmation_event_id','confirmation_prompt_delivery_id']) {
      const value=column==='confirmation_prompt_delivery_id'?foreignDeliveryId:foreignEventId;
      await rejects(`close: foreign ${column}`,'23503',()=>app(()=>insert(tables[1],command({[column]:value}))),await fkName(tables[1],column));
    }
    await rejects('close: foreign conversation','23503',()=>scoped(foreignTenantId,'wasalx_app',()=>insert(tables[1],
      command({tenant_id:foreignTenantId,request_event_id:foreignEventId,confirmation_event_id:foreignEventId,confirmation_prompt_delivery_id:foreignDeliveryId}))),await fkName(tables[1],'conversation_id'));
    await check('app creates native intent; worker creates customer close',async()=>{
      await app(()=>insert(tables[0],native({id:nativeId})));
      await worker(()=>insert(tables[1],command({id:commandId})));
    });
    for (const [table,id,row] of [[tables[0],nativeId,native()],[tables[1],commandId,command()]]) {
      for (const role of ['wasalx_app','wasalx_connector_worker']) {
        await check(`${table}: ${role} same-tenant read`,async()=>assert.equal((await scoped(tenantId,role,()=>client.query(`SELECT id FROM ${table} WHERE id=$1`,[id]))).rowCount,1));
        await check(`${table}: ${role} cross-tenant hidden`,async()=>assert.equal((await scoped(foreignTenantId,role,()=>client.query(`SELECT id FROM ${table} WHERE id=$1`,[id]))).rowCount,0));
      }
      await check(`${table}: cross-tenant update hidden`,async()=>assert.equal((await scoped(foreignTenantId,'wasalx_app',()=>client.query(`UPDATE ${table} SET request_sha256=$2 WHERE id=$1`,[id,'b'.repeat(64)]))).rowCount,0));
      await rejects(`${table}: cross-tenant insert`,'42501',()=>scoped(foreignTenantId,'wasalx_app',()=>insert(table,row)));
      await rejects(`${table}: missing tenant denied`,'42501',()=>scoped('','wasalx_app',()=>client.query(`SELECT id FROM ${table} WHERE id=$1`,[id])));
      await rejects(`${table}: DELETE denied`,'42501',()=>app(()=>client.query(`DELETE FROM ${table} WHERE id=$1`,[id])));
    }
    await rejects('native: worker INSERT denied','42501',()=>worker(()=>insert(tables[0],native())));
    await rejects('native: worker UPDATE denied','42501',()=>worker(()=>update(tables[0],nativeId,{state:'OUTCOME_UNKNOWN'})));
    await rejects('native: worker DELETE denied','42501',()=>worker(()=>client.query('DELETE FROM direct_native_reply_intents WHERE id=$1',[nativeId])));
    for (const [column,value] of Object.entries({id:randomUUID(),tenant_id:foreignTenantId,conversation_id:closeConversationId,
      instance_id:foreignInstanceId,native_ticket_id:'98502',native_actor_id:'78',human_ownership_epoch:3,
      request_sha256:'b'.repeat(64),created_at:new Date('2000-01-01T00:00:00Z')})) {
      await rejects(`native: immutable ${column}`,'55000',()=>app(()=>update(tables[0],nativeId,{[column]:value,state:'OUTCOME_UNKNOWN'})));
    }
    await rejects('native: admitted requires article and delivery','23514',()=>app(()=>update(tables[0],nativeId,{state:'ADMITTED',completed_at:new Date()})));
    for (const reconciliation of [{},{native_ticket_locked:false,article_absent:true},{native_ticket_locked:true},{native_ticket_locked:true,article_absent:false}]) {
      await rejects(`native: rejects incomplete cancellation ${JSON.stringify(reconciliation)}`,'23514',()=>app(()=>update(tables[0],nativeId,{state:'CANCELLED_PROVEN_ABSENT',completed_at:new Date(),reconciliation})));
    }
    await check('native: unknown can reconcile admitted exactly once',async()=>{
      await app(()=>update(tables[0],nativeId,{state:'OUTCOME_UNKNOWN'}));
      await rejects('native: unknown cannot replay pending','55000',()=>app(()=>update(tables[0],nativeId,{state:'PENDING'})));
      await app(()=>update(tables[0],nativeId,{state:'ADMITTED',native_article_id:'985012',delivery_id:promptDeliveryId,completed_at:new Date()}));
      await rejects('native: terminal receipt immutable','55000',()=>app(()=>update(tables[0],nativeId,{reconciliation:{changed:true}})));
    });
    await check('native: proven-absent cancellation terminal',()=>trial(async()=>{
      const row=native(); await app(()=>insert(tables[0],row));
      await app(()=>update(tables[0],row.id,{state:'CANCELLED_PROVEN_ABSENT',completed_at:new Date(),reconciliation:{native_ticket_locked:true,article_absent:true}}));
      await rejects('native: cancelled cannot be readmitted','55000',()=>app(()=>update(tables[0],row.id,{state:'ADMITTED',native_article_id:'985013',delivery_id:promptDeliveryId})));
    }));
    for (const [column,value] of Object.entries({id:randomUUID(),tenant_id:foreignTenantId,conversation_id:conversationId,
      request_event_id:nextConfirmationEventId,confirmation_event_id:nextConfirmationEventId,confirmation_prompt_delivery_id:foreignDeliveryId,
      human_ownership_epoch:3,conversation_fencing_token:8,request_sha256:'b'.repeat(64),created_at:new Date('2000-01-01T00:00:00Z')})) {
      await rejects(`close: immutable ${column}`,'55000',()=>worker(()=>update(tables[1],commandId,{[column]:value})));
    }
    await rejects('close: one pending per conversation','23505',()=>worker(()=>insert(tables[1],command({confirmation_event_id:nextConfirmationEventId}))),'direct_customer_close_one_pending');
    await rejects('close: half lease rejected','23514',()=>worker(()=>update(tables[1],commandId,{lease_id:randomUUID()})));
    await rejects('close: negative fencing rejected','23514',()=>worker(()=>update(tables[1],commandId,{fencing_token:-1})));
    await rejects('close: attempted needs timestamp and snapshot','23514',()=>worker(()=>update(tables[1],commandId,{state:'ATTEMPTED'})));
    await rejects('close: queued cannot claim success','55000',()=>worker(()=>update(tables[1],commandId,{state:'SUCCEEDED'})));
    await rejects('close: unattempted terminal failure needs proof','23514',()=>worker(()=>update(tables[1],commandId,{state:'FAILED_TERMINAL',native_action_snapshot:{},completed_at:new Date(),native_result:{}})));
    await check('close: lease, attempt, unknown, success',async()=>{
      await worker(()=>update(tables[1],commandId,{lease_id:randomUUID(),lease_expires_at:new Date(Date.now()+60000),fencing_token:1}));
      await worker(()=>update(tables[1],commandId,{state:'ATTEMPTED',native_action_snapshot:{ticket_id:'98501',epoch:2},native_attempted_at:new Date()}));
      await rejects('close: attempted snapshot immutable','55000',()=>worker(()=>update(tables[1],commandId,{native_action_snapshot:{ticket_id:'98502'}})));
      await rejects('close: attempted timestamp immutable','55000',()=>worker(()=>update(tables[1],commandId,{native_attempted_at:new Date('2000-01-01T00:00:00Z')})));
      await worker(()=>update(tables[1],commandId,{state:'OUTCOME_UNKNOWN',lease_id:null,lease_expires_at:null}));
      for (const state of ['QUEUED','ATTEMPTED']) await rejects(`close: unknown cannot replay ${state}`,'55000',()=>worker(()=>update(tables[1],commandId,{state})));
      await rejects('close: success needs completion receipt','23514',()=>worker(()=>update(tables[1],commandId,{state:'SUCCEEDED'})));
      await worker(()=>update(tables[1],commandId,{state:'SUCCEEDED',completed_at:new Date(),native_result:{state:'CLOSED'}}));
      await rejects('close: terminal receipt immutable','55000',()=>worker(()=>update(tables[1],commandId,{native_result:{state:'REPLAY'}})));
    });
    await rejects('close: success without authoritative projection cannot be deleted','55000',()=>worker(()=>client.query(
      'DELETE FROM direct_customer_close_commands WHERE id=$1',[commandId])));
    await check('close: foreign connector cannot delete receipt',async()=>assert.equal((await scoped(foreignTenantId,'wasalx_connector_worker',()=>client.query(
      'DELETE FROM direct_customer_close_commands WHERE id=$1',[commandId]))).rowCount,0));
    await rejects('close: confirmation identity globally unique in tenant','23505',()=>worker(()=>insert(tables[1],command({conversation_id:conversationId}))));
    await check('close: terminal frees pending slot; not-attempted failure remains terminal',()=>trial(async()=>{
      const row=command({confirmation_event_id:nextConfirmationEventId}); await worker(()=>insert(tables[1],row));
      await worker(()=>update(tables[1],row.id,{state:'FAILED_TERMINAL',native_action_snapshot:{},native_result:{state:'NOT_ATTEMPTED'},completed_at:new Date()}));
      await rejects('close: failed terminal cannot be retried','55000',()=>worker(()=>update(tables[1],row.id,{state:'QUEUED'})));
      assert.equal((await worker(()=>client.query('DELETE FROM direct_customer_close_commands WHERE id=$1',[row.id]))).rowCount,1);
    }));
    for (const [name,sql,args] of [
      ['conversation negative ownership epoch','UPDATE bot_conversations SET human_ownership_epoch=-1 WHERE id=$1',[conversationId]],
      ['conversation invalid customer','UPDATE bot_conversations SET zammad_customer_id=0 WHERE id=$1',[conversationId]],
      ['conversation control must be object',"UPDATE bot_conversations SET customer_control='[]' WHERE id=$1",[conversationId]],
      ['conversation control size bound',"UPDATE bot_conversations SET customer_control=jsonb_build_object('text',repeat('x',8193)) WHERE id=$1",[conversationId]],
      ['delivery negative ownership epoch','UPDATE delivery_outbox SET direct_ownership_epoch=-1 WHERE id=$1',[promptDeliveryId]],
      ['customer-confirmed requires resolved',"UPDATE bot_conversations SET resolution_kind='CUSTOMER_CONFIRMED' WHERE id=$1",[conversationId]],
    ]) await rejects(name,'23514',()=>app(()=>client.query(sql,args)));
    for (const table of tables) {
      const row=table===tables[0]?native({human_ownership_epoch:-1}):command({conversation_id:conversationId,confirmation_event_id:nextConfirmationEventId,human_ownership_epoch:-1});
      await rejects(`${table}: negative ownership snapshot`,'23514',()=>app(()=>insert(table,row)));
    }
    await rejects('close: negative conversation fence','23514',()=>worker(()=>insert(tables[1],command({conversation_id:conversationId,confirmation_event_id:nextConfirmationEventId,conversation_fencing_token:-1}))));
    await check('customer-confirmed resolution accepted',()=>trial(()=>app(()=>client.query(
      "UPDATE bot_conversations SET state='RESOLVED',resolution_kind='CUSTOMER_CONFIRMED',resolved_at=now() WHERE id=$1",[conversationId]))));
    for (const state of ['PENDING','OUTCOME_UNKNOWN']) await check(`privacy retains ${state} native intent`,()=>trial(async()=>{
      const row=native(); await app(()=>insert(tables[0],row));
      if(state==='OUTCOME_UNKNOWN')await app(()=>update(tables[0],row.id,{state}));
      await rejects(`native: ${state} parent cascade denied`,'55000',()=>client.query('DELETE FROM bot_conversations WHERE id=$1',[conversationId]));
      assert.equal((await client.query('SELECT id FROM direct_native_reply_intents WHERE id=$1',[row.id])).rowCount,1);
    }));
    for (const state of ['QUEUED','ATTEMPTED','OUTCOME_UNKNOWN']) await check(`privacy retains ${state} close command`,()=>trial(async()=>{
      const row=command({confirmation_event_id:nextConfirmationEventId}); await worker(()=>insert(tables[1],row));
      if(state!=='QUEUED')await worker(()=>update(tables[1],row.id,{state:'ATTEMPTED',native_action_snapshot:{ticket_id:'98501'},native_attempted_at:new Date()}));
      if(state==='OUTCOME_UNKNOWN')await worker(()=>update(tables[1],row.id,{state}));
      await rejects(`close: ${state} occupies pending slot`,'23505',()=>worker(()=>insert(tables[1],command({confirmation_event_id:requestEventId}))),'direct_customer_close_one_pending');
      await rejects(`close: ${state} direct cleanup denied`,'55000',()=>worker(()=>client.query('DELETE FROM direct_customer_close_commands WHERE id=$1',[row.id])));
      await rejects(`close: ${state} parent cascade denied`,'55000',()=>client.query('DELETE FROM event_inbox WHERE id=$1',[nextConfirmationEventId]));
      assert.equal((await client.query('SELECT id FROM direct_customer_close_commands WHERE id=$1',[row.id])).rowCount,1);
    }));
    await check('close: resolved projection permits worker receipt cleanup',()=>trial(async()=>{
      await app(()=>client.query("UPDATE bot_conversations SET state='RESOLVED',resolution_kind='CUSTOMER_CONFIRMED',resolved_at=now() WHERE id=$1",[closeConversationId]));
      assert.equal((await worker(()=>client.query('DELETE FROM direct_customer_close_commands WHERE id=$1',[commandId]))).rowCount,1);
    }));
    await check('close: newer conversation fence permits old succeeded receipt cleanup',()=>trial(async()=>{
      await app(()=>client.query('UPDATE bot_conversations SET fencing_token=fencing_token+1 WHERE id=$1',[closeConversationId]));
      assert.equal((await worker(()=>client.query('DELETE FROM direct_customer_close_commands WHERE id=$1',[commandId]))).rowCount,1);
    }));
    await app(()=>client.query("UPDATE bot_conversations SET state='RESOLVED',resolution_kind='CUSTOMER_CONFIRMED',resolved_at=now() WHERE id=$1",[closeConversationId]));
    // Verify FK cleanup only. Full held/non-target privacy behavior belongs to the existing privacy suite.
    for (const [name,sql,args,expectedNative,expectedCommand] of [
      ['delivery','DELETE FROM delivery_outbox WHERE id=$1',[promptDeliveryId],0,0],
      ['request event','DELETE FROM event_inbox WHERE id=$1',[requestEventId],1,0],
      ['confirmation event','DELETE FROM event_inbox WHERE id=$1',[confirmationEventId],1,0],
      ['conversation','DELETE FROM bot_conversations WHERE id=$1',[conversationId],0,1],
    ]) await check(`privacy parent cascade: ${name}`,()=>trial(async()=>{
      await client.query(sql,args);
      assert.equal((await client.query('SELECT id FROM direct_native_reply_intents WHERE id=$1',[nativeId])).rowCount,expectedNative);
      assert.equal((await client.query('SELECT id FROM direct_customer_close_commands WHERE id=$1',[commandId])).rowCount,expectedCommand);
    }));

    // Real contention uses an already committed canonical row, never invisible
    // uncommitted fixture data. The second connection only takes/releases locks.
    const existing=(await client.query('SELECT assignment_id,external_chat_id FROM bot_conversations WHERE tenant_id=$1 AND id=$2',[tenantId,existingConversationId])).rows[0];
    assert(existing,'committed canonical conversation prerequisite');
    const contender=new pg.Client({connectionString:adminUrl}); await contender.connect();
    try {
      for(const kind of ['route','row'])await check(`runtime: ${kind} admission contention fails without waiting`,async()=>{
        await contender.query('BEGIN');
        try {
          await contender.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
          await contender.query("SET LOCAL statement_timeout='3s'");
          if(kind==='route')await contender.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${tenantId}:${existing.assignment_id}:${existing.external_chat_id}`]);
          else await contender.query('SELECT id FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,existingConversationId]);
          await trial(async()=>{
            await client.query("SET LOCAL statement_timeout='3s'");
            await assert.rejects(()=>app(()=>tryLockDirectConversation(client,{tenantId,assignmentId:existing.assignment_id,
              chatId:existing.external_chat_id,conversationId:existingConversationId})),
            error=>kind==='route'?error.message==='DIRECT_CONVERSATION_BUSY':error.code==='55P03');
          });
        } finally {await contender.query('ROLLBACK');}
      });
    } finally {await contender.end();}

    const runtimeConnectionId=randomUUID();
    await client.query(`INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference)
      VALUES($1,$2,'Direct keep-open SQL proof','WAHA','GOWS','WORKING',$3)`,
      [runtimeConnectionId,tenantId,`secret://${tenantId}/connections/${runtimeConnectionId}/waha`]);
    const flow={schemaVersion:1,name:`Keep-open ${prefix}`,start:'hello',maxSteps:10,nodes:[{id:'hello',type:'end'}],
      keepOpenPolicy:{humanReplyPauseMinutes:120,mainMenu:true,customerResolution:true}};
    const familyId=(await app(()=>client.query('SELECT app.create_bot_flow_family($1,$2) AS id',[flow.name,userId]))).rows[0].id;
    const runtimeVersion=(await app(()=>client.query('SELECT * FROM app.create_bot_flow_version($1,$2,NULL,$3)',[familyId,flow,userId]))).rows[0];
    await app(()=>client.query('SELECT * FROM app.activate_bot_flow_version($1,$2,NULL,$3)',[runtimeVersion.id,runtimeVersion.revision,userId]));
    const runtimeAssignment=(await app(()=>client.query('SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)',[runtimeConnectionId,familyId,'2',runtimeVersion.id,userId]))).rows[0];
    const runtimeConversation=async(suffix,ticketId)=>{
      const id=randomUUID(),chatId=`${prefix}-${suffix}@c.us`;
      await conversation(id,suffix,{assignmentId:runtimeAssignment.assignment_id,assignedConnectionId:runtimeConnectionId,versionId:runtimeVersion.id,ticketId});
      return{id,chatId,ticketId};
    };
    const delivery=async(route,{id=randomUUID(),origin='HUMAN',epoch=2,state='SENT',batchId=null,sequence=0,parts=1,finishedAt=null,articleId='985599'}={})=>{
      await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
        message_body,content_type,idempotency_key,state,direct_origin,direct_ownership_epoch,batch_id,batch_sequence,batch_part_count,attempts)
        VALUES($1,$2,$3,$4,$5,$6,$14,'Synthetic runtime proof','text/plain',$7,$8,$9,$10,$11,$12,$13,1)`,
        [id,tenantId,runtimeConnectionId,route.id,route.chatId,route.ticketId,`${prefix}-${id}`,state,origin,epoch,batchId,sequence,parts,articleId]);
      await client.query(`INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state,started_at,finished_at)
        VALUES($1,$2,1,$3,COALESCE($4::timestamptz,now()-interval '15 minutes')-interval '1 minute',$4)`,[tenantId,id,state,finishedAt]);
      return id;
    };
    const applicationRejects=(name,pattern,action)=>check(name,()=>trial(()=>assert.rejects(action,pattern)));
    await check('runtime: reserve, admission, durable completion and exact replay',()=>trial(async()=>{
      const route=await runtimeConversation('native-runtime','98551');
      await app(()=>client.query("UPDATE bot_conversations SET state='BOT' WHERE id=$1",[route.id]));
      const input={tenantId,instanceId,operationId:randomUUID(),connectionId:runtimeConnectionId,chatId:route.chatId,ticketId:route.ticketId,
        actorId:'77',nativeGroupId:'2',actorFullGroupIds:['2'],requestSha256:hash};
      const reserved=await app(()=>reserveDirectNativeReply(client,input));
      assert.deepEqual(reserved,{id:input.operationId,conversation_id:route.id,human_ownership_epoch:3});
      assert.deepEqual((await client.query('SELECT state,human_ownership_epoch::int AS epoch,fencing_token::int AS fence FROM bot_conversations WHERE id=$1',[route.id])).rows[0],{state:'HUMAN',epoch:3,fence:8});
      assert.deepEqual(await app(()=>reserveDirectNativeReply(client,input)),reserved);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM bot_conversation_events WHERE conversation_id=$1 AND event_kind='HANDOFF_COMPLETED'",[route.id])).rows[0].n,1);
      const admission={...input,conversationId:route.id,articleId:'985512'};
      assert.deepEqual(await app(()=>admitDirectReplyIntent(client,admission)),{epoch:3,routingEpoch:undefined,acceptedDeliveryId:null});
      await applicationRejects('runtime: second intent held while first pending',/DIRECT_NATIVE_EFFECT_HOLD/,()=>app(()=>reserveDirectNativeReply(client,{...input,operationId:randomUUID()})));
      await trial(async()=>{
        await app(()=>update(tables[0],input.operationId,{state:'OUTCOME_UNKNOWN'}));
        await applicationRejects('runtime: unknown intent cannot be admitted',/DIRECT_NATIVE_INTENT_DENIED/,()=>app(()=>admitDirectReplyIntent(client,admission)));
        await applicationRejects('runtime: unknown intent keeps next reply held',/DIRECT_NATIVE_EFFECT_HOLD/,()=>app(()=>reserveDirectNativeReply(client,{...input,operationId:randomUUID()})));
      });
      await trial(async()=>{
        await app(()=>client.query('UPDATE bot_conversations SET human_ownership_epoch=4 WHERE id=$1',[route.id]));
        await applicationRejects('runtime: stale native ownership epoch rejected',/DIRECT_NATIVE_INTENT_DENIED/,()=>app(()=>admitDirectReplyIntent(client,admission)));
      });
      const acceptedDeliveryId=await delivery(route,{epoch:3,finishedAt:new Date(),articleId:admission.articleId});
      await app(()=>completeDirectReplyIntent(client,{tenantId,operationId:input.operationId,articleId:admission.articleId,deliveryId:acceptedDeliveryId}));
      assert.deepEqual(await app(()=>admitDirectReplyIntent(client,admission)),{epoch:3,routingEpoch:undefined,acceptedDeliveryId});
      await applicationRejects('runtime: altered article replay denied',/DIRECT_NATIVE_INTENT_DENIED/,()=>app(()=>admitDirectReplyIntent(client,{...admission,articleId:'985513'})));
    }));
    await check('runtime: pending native projection survives same-state activity and keeps exact lease admission',()=>trial(async()=>{
      const route=await runtimeConversation('projection-runtime','98559');
      const repository=Object.create(OutboxRepository.prototype);
      repository.tenant=(scope,action)=>scoped(scope,'wasalx_connector_worker',()=>action(client));
      await app(()=>client.query("UPDATE bot_conversations SET state='BOT',fencing_token=fencing_token+1 WHERE id=$1",[route.id]));
      await app(()=>client.query('UPDATE bot_conversations SET fencing_token=fencing_token+1 WHERE id=$1',[route.id]));
      const read=async()=>(await worker(()=>client.query('SELECT * FROM zammad_conversation_state_outbox WHERE tenant_id=$1 AND conversation_id=$2',[tenantId,route.id]))).rows[0];
      const before=await read();assert.equal(Number(before.conversation_fencing_token),8);
      const lease=randomUUID();
      const claim=()=>worker(()=>client.query("UPDATE zammad_conversation_state_outbox SET lease_id=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1",[before.id,lease]));
      const job={tenantId,id:before.id,conversationId:route.id,ticketId:route.ticketId,state:'BOT',conversationFencingToken:8};
      await claim();assert.equal(await repository.beginConversationState(job,lease),false,'stale fence cannot send');
      const refreshed=await read();
      assert.equal(Number(refreshed.conversation_fencing_token),9);assert.equal(refreshed.completed_at,null);assert.equal(refreshed.lease_id,null);
      assert.equal(await repository.beginConversationState(job,lease),false,'old lease cannot admit refreshed row');
      await claim();job.conversationFencingToken=9;
      assert.equal(await repository.beginConversationState({...job,tenantId:foreignTenantId},lease),false,'foreign tenant cannot admit row');
      assert.equal(await repository.beginConversationState(job,lease),true);
      await repository.completeConversationState(job,lease);
      assert.ok((await read()).completed_at);
    }));
    await check('runtime: late native completion repairs a changed state after its completed projection fence advances',()=>trial(async()=>{
      const route=await runtimeConversation('projection-late-runtime','98560');
      const repository=Object.create(OutboxRepository.prototype);
      repository.tenant=(scope,action)=>scoped(scope,'wasalx_connector_worker',()=>action(client));
      const read=async()=>(await worker(()=>client.query('SELECT * FROM zammad_conversation_state_outbox WHERE tenant_id=$1 AND conversation_id=$2',[tenantId,route.id]))).rows[0];
      const before=await read(),oldLease=randomUUID(),newLease=randomUUID();
      const claim=lease=>worker(()=>client.query("UPDATE zammad_conversation_state_outbox SET lease_id=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1",[before.id,lease]));
      const oldJob={tenantId,id:before.id,conversationId:route.id,ticketId:route.ticketId,state:'HUMAN',conversationFencingToken:7};
      await claim(oldLease);assert.equal(await repository.beginConversationState(oldJob,oldLease),true);
      await app(()=>client.query("UPDATE bot_conversations SET state='BOT',fencing_token=fencing_token+1 WHERE id=$1",[route.id]));
      const botJob={...oldJob,state:'BOT',conversationFencingToken:8};
      await claim(newLease);assert.equal(await repository.beginConversationState(botJob,newLease),true);
      await repository.completeConversationState(botJob,newLease);assert.ok((await read()).completed_at);
      await app(()=>client.query('UPDATE bot_conversations SET fencing_token=fencing_token+1 WHERE id=$1',[route.id]));
      await repository.completeConversationState(oldJob,oldLease);
      const correction=await read();
      assert.equal(correction.conversation_state,'BOT');assert.equal(Number(correction.conversation_fencing_token),9);
      assert.equal(correction.completed_at,null);assert.equal(correction.lease_id,null);
      await claim(newLease);botJob.conversationFencingToken=9;
      assert.equal(await repository.beginConversationState(botJob,newLease),true);
      await app(()=>client.query('UPDATE bot_conversations SET fencing_token=fencing_token+1 WHERE id=$1',[route.id]));
      await repository.completeConversationState(botJob,newLease);
      assert.ok((await read()).completed_at,'token-only activity does not require another native state write');
    }));
    await check('runtime: human pause resets only for complete same-epoch HUMAN batch',()=>trial(async()=>{
      const route=await runtimeConversation('batch-runtime','98550'),batchId=randomUUID();
      const anchor=new Date(Date.now()-600000),firstFinished=new Date(anchor.getTime()+60000),lastFinished=new Date(anchor.getTime()+120000);
      await app(()=>client.query('UPDATE bot_conversations SET human_pause_started_at=$2 WHERE id=$1',[route.id,anchor]));
      const first=await delivery(route,{batchId,sequence:0,parts:2,finishedAt:firstFinished});
      const reset=()=>worker(()=>resetDirectHumanPauseForCompletedBatch(client,{tenantId,conversationId:route.id,deliveryId:first}));
      const readAnchor=async()=>(await client.query('SELECT human_pause_started_at AS anchor FROM bot_conversations WHERE id=$1',[route.id])).rows[0].anchor.toISOString();
      assert.equal(await reset(),false,'missing batch part cannot reset anchor');
      const last=await delivery(route,{batchId,sequence:1,parts:2,state:'QUEUED'});
      assert.equal(await reset(),false,'queued batch part cannot reset anchor');
      await client.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1",[last]);
      await client.query("UPDATE delivery_attempts SET state='OUTCOME_UNKNOWN',finished_at=$2 WHERE delivery_id=$1",[last,lastFinished]);
      assert.equal(await reset(),false,'unknown batch part cannot reset anchor'); assert.equal(await readAnchor(),anchor.toISOString());
      await client.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[last]);
      await client.query("UPDATE delivery_attempts SET state='SENT' WHERE delivery_id=$1",[last]);
      assert.equal(await reset(),true); assert.equal(await readAnchor(),lastFinished.toISOString(),'anchor is actual last attempt completion');
      assert.equal(await reset(),true); assert.equal(await readAnchor(),lastFinished.toISOString(),'replay must not advance anchor to now');
      for(const [name,sql,args] of [
        ['different conversation epoch','UPDATE bot_conversations SET human_ownership_epoch=3 WHERE id=$1',[route.id]],
        ['mixed part epoch','UPDATE delivery_outbox SET direct_ownership_epoch=3 WHERE id=$1',[last]],
        ['BOT ownership',"UPDATE bot_conversations SET state='BOT' WHERE id=$1",[route.id]],
        ['BOT delivery',"UPDATE delivery_outbox SET direct_origin='BOT' WHERE id=$1",[first]],
      ])await trial(async()=>{
        await client.query(sql,args);assert.equal(await reset(),false,name);assert.equal(await readAnchor(),lastFinished.toISOString());
      });
    }));

    // Real SQL/roles; only native article append is synthetic, matching the canonical caller.
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    const rc2Connection=randomUUID();
    await client.query(`INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference)
      VALUES($1,$2,'RC2 SQL controls','WAHA','GOWS','WORKING',$3)`,[rc2Connection,tenantId,`secret://${tenantId}/connections/${rc2Connection}/waha`]);
    const rc2Flow={schemaVersion:1,name:`RC2 ${prefix}`,start:'welcome',mainMenuNodeId:'step_1',welcomeResendMinutes:60,maxSteps:20,
      keepOpenPolicy:{humanReplyPauseMinutes:null,mainMenu:true,customerResolution:true},
      entryCommands:[{id:'legacy_menu',aliases:['menu command'],target:'command',enabled:true}],nodes:[
        {id:'welcome',type:'choice',prompt:'Welcome',options:[{id:'open',label:'Continue',next:'step_1'}]},
        {id:'step_1',type:'choice',prompt:'Main menu',options:[{id:'agent',label:'Human',next:'handoff'}]},
        {id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal',message:'Our team will follow up',mainMenuReturn:{label:'Main Menu'}},
        {id:'command',type:'send_text',text:'Entry {{message.text}}',next:'command_menu'},
        {id:'command_menu',type:'choice',prompt:'After command',options:[{id:'back',label:'Return',next:'step_1'}]}]};
    const rc2Family=(await app(()=>client.query('SELECT app.create_bot_flow_family($1,$2) AS id',[rc2Flow.name,userId]))).rows[0].id;
    const rc2Version=(await app(()=>client.query('SELECT * FROM app.create_bot_flow_version($1,$2,NULL,$3)',[rc2Family,rc2Flow,userId]))).rows[0];
    await app(()=>client.query('SELECT * FROM app.activate_bot_flow_version($1,$2,NULL,$3)',[rc2Version.id,rc2Version.revision,userId]));
    const rc2Assignment=(await app(()=>client.query('SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)',[rc2Connection,rc2Family,'2',rc2Version.id,userId]))).rows[0];
    const rc2Route=async({state='BOT',node='step_1'}={})=>{
      const id=randomUUID(),chatId=`9665${String(++serial).padStart(9,'0')}@c.us`,ticketId=`986${serial}`;
      await client.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,
        state,current_node_id,last_activity_at,normalized_reference,zammad_ticket_id,zammad_ticket_number,human_ownership_epoch,fencing_token,zammad_customer_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-interval '2 hours',$9,$10,$10,2,7,77)`,
        [id,tenantId,rc2Assignment.assignment_id,rc2Connection,rc2Version.id,chatId,state,node,`BOT-${id.replaceAll('-','').slice(0,12).toUpperCase()}`,ticketId]);
      return{id,chatId,ticketId};
    };
    const rc2Read=route=>worker(()=>client.query('SELECT * FROM bot_conversations WHERE tenant_id=$1 AND id=$2',[tenantId,route.id])).then(r=>r.rows[0]);
    const rc2Output=async(route,id=randomUUID())=>{
      await client.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,
        message_body,content_type,idempotency_key,state,direct_origin) VALUES($1,$2,$3,$4,$5,$6,'Synthetic RC2 member','text/plain',$7,'QUEUED','BOT')`,
        [id,tenantId,rc2Connection,route.id,route.chatId,route.ticketId,`${prefix}-rc2-${id}`]);return id;
    };
    const rc2Settle=async(id,finished,state='SENT')=>worker(async()=>{
      assert(['SENT','OUTCOME_UNKNOWN','FAILED_TERMINAL'].includes(state));
      const external=state==='SENT'?`synthetic-${id}`:null,lease=randomUUID();
      // Seed a fresh current attempt, then record its receipt under the real worker fence.
      // Existing UNKNOWN/SENT evidence is never upserted or converted into a new effect.
      const started=await client.query(`UPDATE delivery_outbox SET state='SENDING',attempts=1,lease_id=$3,
        lease_expires_at=now()+interval '1 minute' WHERE tenant_id=$1 AND id=$2 AND state='QUEUED'
        AND attempts=0 AND external_message_id IS NULL AND lease_id IS NULL RETURNING id`,[tenantId,id,lease]);
      assert.equal(started.rowCount,1,'RC2 completion requires a fresh unattempted fixture delivery');
      await client.query(`INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state,started_at)
        VALUES($1,$2,1,'SENDING',$3::timestamptz-interval '1 second')`,[tenantId,id,finished]);
      const parent=await client.query(`UPDATE delivery_outbox SET state=$3,external_message_id=$4,
        lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='SENDING'
        AND lease_id=$5 AND attempts=1 RETURNING id`,[tenantId,id,state,external,lease]);
      assert.equal(parent.rowCount,1,'RC2 completion lost its current parent attempt');
      const attempt=await client.query(`UPDATE delivery_attempts SET state=$3,finished_at=$4,external_message_id=$5
        WHERE tenant_id=$1 AND delivery_id=$2 AND attempt_number=1 AND state='SENDING'
        AND finished_at IS NULL AND external_message_id IS NULL RETURNING id`,[tenantId,id,state,finished,external]);
      assert.equal(attempt.rowCount,1,'RC2 completion lost its unfinished current attempt');
    });
    const rc2Input=async(route,eventId,text,at=new Date(Date.now()+1000).toISOString())=>({tenantId,connectionId:rc2Connection,eventId,chatId:route.chatId,
      flow:rc2Flow,flowVersionId:rc2Version.id,conversation:await rc2Read(route),customerId:77,assignmentActive:true,
      message:{provider:'waha',connectionId:rc2Connection,eventId:`${prefix}-${eventId}`,messageId:`rc2-${eventId}`,chatId:route.chatId,senderId:route.chatId,
        input:{type:'text',text},fromApi:false,fromMe:false,timestamp:at}});
    const rc2Process=async(input,counters)=>{
      const repository=Object.create(InboundRepository.prototype);
      repository.tenant=(scope,action)=>scoped(scope,'wasalx_connector_worker',async()=>{
        assert.equal((await client.query('SELECT current_user AS role')).rows[0].role,'wasalx_connector_worker');return action(client);
      });
      return repository.processDirectMessage({id:input.eventId,tenantId,connectionId:rc2Connection,provider:'waha',providerEventId:`${prefix}-${input.eventId}`,eventType:'message',payload:{},attempts:1},
        {assignmentId:rc2Assignment.assignment_id,assignmentZammadGroup:'2',zammadGroup:'2',zammadBaseUrl:'https://zammad.invalid',zammadSecretReference:'secret'},input.message,{id:77,login:'synthetic-rc2-customer'},
        {create:async()=>{throw new Error('RC2 created another ticket');},append:async ticket=>{assert.equal(ticket,input.conversation.zammad_ticket_id);counters.appended+=1;return undefined;}});
    };
    const rc2Counts=route=>client.query(`SELECT
      (SELECT count(*)::int FROM delivery_outbox WHERE tenant_id=$1 AND bot_conversation_id=$2) AS deliveries,
      (SELECT count(*)::int FROM direct_customer_close_commands WHERE tenant_id=$1 AND conversation_id=$2) AS closes,
      (SELECT count(*)::int FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$3 AND external_group_id=$4) AS messages`,
      [tenantId,route.id,rc2Connection,route.chatId]).then(r=>r.rows[0]);

    await check('RC2 SQL: full successful welcome burst anchors last finish; partial/UNKNOWN holds and duplicate has no extra output',()=>trial(async()=>{
      const route=await rc2Route(),source=await event(tenantId,rc2Connection),first=await rc2Output(route),last=randomUUID();
      const firstFinished=new Date(Date.now()-3600000),lastFinished=new Date(firstFinished.getTime()+1000);await rc2Settle(first,firstFinished);
      await worker(()=>client.query(`INSERT INTO bot_conversation_events(tenant_id,conversation_id,event_inbox_id,event_kind,safe_metadata,created_at)
        VALUES($1,$2,$3,'MESSAGE',$4,transaction_timestamp()+interval '1 microsecond')`,[tenantId,route.id,source,{welcome_cycle:{flow_version_id:rc2Version.id,delivery_ids:[first,last]}}]));
      const input=await rc2Input(route,await event(tenantId,rc2Connection),'Another request',new Date(lastFinished.getTime()+3600000).toISOString());
      const inspect=()=>worker(()=>inspectDirectWelcomeResendInput(client,input));
      await assert.rejects(inspect,/DIRECT_PENDING_EFFECTS/,'missing burst member');await rc2Output(route,last);
      await assert.rejects(inspect,/DIRECT_PENDING_EFFECTS/,'queued burst member');
      await trial(async()=>{await rc2Settle(last,lastFinished,'OUTCOME_UNKNOWN');
        await assert.rejects(inspect,/DIRECT_PENDING_EFFECTS/,'UNKNOWN burst member');});
      await rc2Settle(last,lastFinished);
      input.message.timestamp=new Date(firstFinished.getTime()+3600000).toISOString();assert.equal(await inspect(),null,'first member is not the full burst anchor');
      input.message.timestamp=new Date(lastFinished.getTime()+3600000).toISOString();assert.equal((await inspect()).kind,'WELCOME_RESEND');
      const counters={appended:0},before=await rc2Counts(route);assert.equal((await rc2Process(input,counters)).state,'BOT');const row=await rc2Read(route);
      assert.equal(row.current_node_id,'welcome');assert.equal(row.zammad_ticket_id,route.ticketId);assert.equal(Number(row.human_ownership_epoch),2);
      const latest=(await worker(()=>client.query(`SELECT safe_metadata->'welcome_cycle' AS cycle FROM bot_conversation_events
        WHERE tenant_id=$1 AND conversation_id=$2 AND safe_metadata ? 'welcome_cycle' ORDER BY created_at DESC,id DESC LIMIT 1`,[tenantId,route.id]))).rows[0].cycle;
      assert.equal(latest.flow_version_id,rc2Version.id);assert.equal(latest.delivery_ids.length,1);
      assert.equal(latest.delivery_ids.some(id=>id===first||id===last),false,'new serialized welcome supersedes the older transaction-start cycle');
      const count=await rc2Counts(route);assert.deepEqual(count,{deliveries:before.deliveries+1,closes:0,messages:1});
      assert.equal((await rc2Process(input,counters)).duplicate,true);assert.deepEqual(await rc2Counts(route),count);assert.equal(counters.appended,1);
    }));

    await check('RC2 SQL: successful handoff Main Menu returns to explicit choice on same ticket; epoch/foreign/UNKNOWN fences remain',()=>trial(async()=>{
      const route=await rc2Route({state:'HANDOFF_PENDING',node:'handoff'}),source=await event(tenantId,rc2Connection),jobId=randomUUID(),lease=randomUUID();
      await client.query(`INSERT INTO bot_handoff_jobs(id,tenant_id,conversation_id,source_event_id,handoff_node_id,zammad_group_id,priority,state,attempts,fencing_token,lease_id,lease_expires_at)
        VALUES($1,$2,$3,$4,'handoff','2','2 normal','RUNNING',1,1,$5,now()+interval '1 minute')`,[jobId,tenantId,route.id,source,lease]);
      const repository=Object.create(OutboxRepository.prototype);repository.tenant=(scope,action)=>scoped(scope,'wasalx_connector_worker',()=>action(client));
      await repository.completeBotHandoff({tenantId,id:jobId,conversationId:route.id,handoffNodeId:'handoff',fencingToken:1},lease);
      let row=await rc2Read(route);const prompt=row.customer_control.promptDeliveryId;
      assert.equal(row.state,'HUMAN');assert.equal(Number(row.human_ownership_epoch),3);assert.ok(row.human_pause_started_at);
      assert.equal(row.customer_control.options.find(o=>o.kind==='MAIN_MENU').label,'Main Menu');assert.equal((await rc2Counts(route)).deliveries,1);
      const own=await rc2Input(route,await event(tenantId,rc2Connection),'1');assert.equal(await worker(()=>inspectDirectKeepOpenInput(client,own)),null,'queued prompt is not authority');
      await rc2Settle(prompt,new Date());
      for(const kind of ['epoch','foreign-chat','old-input'])await trial(async()=>{
        if(kind==='epoch')await app(()=>client.query('UPDATE bot_conversations SET human_ownership_epoch=4 WHERE id=$1',[route.id]));
        const current=await rc2Input(route,own.eventId,'1');if(kind==='foreign-chat')current.chatId='12025550139@c.us';if(kind==='old-input')current.message.timestamp='2000-01-01T00:00:00Z';
        assert.equal(await worker(()=>inspectDirectKeepOpenInput(client,current)),null,kind);
      });
      for(const state of ['PENDING','OUTCOME_UNKNOWN'])await trial(async()=>{
        const intent=native({conversation_id:route.id,native_ticket_id:route.ticketId,human_ownership_epoch:3});await app(()=>insert(tables[0],intent));
        if(state==='OUTCOME_UNKNOWN')await app(()=>update(tables[0],intent.id,{state}));const before=await rc2Counts(route);
        await assert.rejects(worker(()=>inspectDirectKeepOpenInput(client,own)),/DIRECT_NATIVE_EFFECT_HOLD/);assert.deepEqual(await rc2Counts(route),before);
      });
      const counters={appended:0};assert.equal((await rc2Process(own,counters)).state,'BOT');row=await rc2Read(route);
      assert.equal(row.current_node_id,'step_1','neutral 1 must not also select the next branch');assert.equal(row.zammad_ticket_id,route.ticketId);
      assert.equal(Number(row.human_ownership_epoch),3);assert.equal(row.customer_control,null);const count=await rc2Counts(route);
      assert.deepEqual(count,{deliveries:2,closes:0,messages:1});assert.equal(counters.appended,1);
      assert.equal((await rc2Process(own,counters)).duplicate,true);assert.deepEqual(await rc2Counts(route),count);assert.equal(counters.appended,1);
    }));

    await check('RC2 SQL: Main Menu replaces a failed welcome anchor; only a fully delivered new menu admits the next text choice',()=>trial(async()=>{
      const route=await rc2Route({node:'welcome'}),oldSource=await event(tenantId,rc2Connection),old=await rc2Output(route);
      await rc2Settle(old,new Date(Date.now()-7200000),'FAILED_TERMINAL');
      await worker(()=>client.query(`INSERT INTO bot_conversation_events(tenant_id,conversation_id,event_inbox_id,event_kind,safe_metadata,created_at)
        VALUES($1,$2,$3,'MESSAGE',$4,clock_timestamp())`,[tenantId,route.id,oldSource,{welcome_cycle:{flow_version_id:rc2Version.id,delivery_ids:[old]}}]));
      const oldRead=async()=>(await worker(()=>client.query(`SELECT d.state,d.attempts,d.external_message_id,a.state AS attempt_state,a.finished_at
        FROM delivery_outbox d JOIN delivery_attempts a ON a.tenant_id=d.tenant_id AND a.delivery_id=d.id AND a.attempt_number=d.attempts
        WHERE d.tenant_id=$1 AND d.id=$2`,[tenantId,old]))).rows[0];
      const preimage=await oldRead(),counters={appended:0},first=await rc2Input(route,await event(tenantId,rc2Connection),'Main menu');
      assert.equal((await rc2Process(first,counters)).state,'BOT');assert.equal((await rc2Read(route)).current_node_id,'step_1');
      const cycle=(await worker(()=>client.query(`SELECT safe_metadata->'welcome_cycle' AS cycle FROM bot_conversation_events
        WHERE tenant_id=$1 AND conversation_id=$2 AND safe_metadata ? 'welcome_cycle' ORDER BY created_at DESC,id DESC LIMIT 1`,[tenantId,route.id]))).rows[0].cycle;
      assert.equal(cycle.flow_version_id,rc2Version.id);assert.equal(cycle.delivery_ids.length,1);assert.notEqual(cycle.delivery_ids[0],old);
      const menu=cycle.delivery_ids[0],next=await rc2Input(route,await event(tenantId,rc2Connection),'1',new Date(Date.now()+2000).toISOString());
      const before=await rc2Counts(route);
      assert.equal((await rc2Process(next,counters)).pendingTarget,true,'queued new menu holds');assert.deepEqual(await rc2Counts(route),before);
      await trial(async()=>{await rc2Settle(menu,new Date(),'OUTCOME_UNKNOWN');
        assert.equal((await rc2Process(next,counters)).pendingTarget,true,'UNKNOWN new menu holds');assert.deepEqual(await rc2Counts(route),before);});
      assert.equal(counters.appended,1,'held choices cannot append native articles');
      await rc2Settle(menu,new Date());assert.equal((await rc2Process(next,counters)).state,'HANDOFF_PENDING');
      const current=await rc2Read(route);assert.equal(current.zammad_ticket_id,route.ticketId);assert.equal(Number(current.human_ownership_epoch),2);
      const after=await rc2Counts(route);assert.deepEqual(after,{deliveries:3,closes:0,messages:2});assert.equal(counters.appended,2);
      const handoff=(await worker(()=>client.query('SELECT state,zammad_group_id FROM bot_handoff_jobs WHERE tenant_id=$1 AND conversation_id=$2',[tenantId,route.id]))).rows;
      assert.equal(handoff.length,1);assert.equal(handoff[0].state,'QUEUED');assert.equal(handoff[0].zammad_group_id,'2');
      assert.equal((await rc2Process(next,counters)).duplicate,true);assert.deepEqual(await rc2Counts(route),after);
      assert.deepEqual(await oldRead(),preimage,'old terminal attempt/provider history is immutable');
    }));

    await check('RC2 SQL: settled own BOT command has fresh variables; pending/UNKNOWN holds before append and duplicate is inert',()=>trial(async()=>{
      const route=await rc2Route(),source=await event(tenantId,rc2Connection);await app(()=>client.query("UPDATE bot_conversations SET variables='{\"action.old\":\"must-not-carry\"}',step_count=4 WHERE id=$1",[route.id]));
      const input=await rc2Input(route,source,'menu command'),counters={appended:0};
      for(const state of ['QUEUED','OUTCOME_UNKNOWN'])await trial(async()=>{
        const held=await rc2Output(route);if(state==='OUTCOME_UNKNOWN')await rc2Settle(held,new Date(),state);
        const before=await rc2Counts(route),result=await rc2Process(input,counters);assert.equal(result.pendingTarget,true);assert.equal(counters.appended,0);assert.deepEqual(await rc2Counts(route),before);
      });
      assert.equal((await rc2Process(input,counters)).state,'BOT');const row=await rc2Read(route);
      assert.equal(row.current_node_id,'command_menu');assert.equal(row.zammad_ticket_id,route.ticketId);assert.equal(Number(row.human_ownership_epoch),2);
      assert.equal(Object.hasOwn(row.variables,'action.old'),false);assert.equal(row.variables['message.text'],'menu command');
      const output=(await worker(()=>client.query('SELECT message_body FROM delivery_outbox WHERE tenant_id=$1 AND bot_conversation_id=$2',[tenantId,route.id]))).rows;
      assert(output.some(r=>r.message_body==='Entry menu command'));assert.equal(output.length,2);
      const audit=(await worker(()=>client.query('SELECT safe_metadata FROM bot_conversation_events WHERE tenant_id=$1 AND conversation_id=$2 AND event_inbox_id=$3',[tenantId,route.id,source]))).rows[0];
      assert.equal(audit.safe_metadata.entry_command_id,'legacy_menu');const count=await rc2Counts(route);
      assert.equal((await rc2Process(input,counters)).duplicate,true);assert.deepEqual(await rc2Counts(route),count);assert.equal(counters.appended,1);
    }));

    for(const receiptFirst of [false,true])await check(`runtime: customer close ${receiptFirst?'receipt before callback':'callback before receipt'} converges`,()=>trial(async()=>{
      const route=await runtimeConversation(`close-runtime-${receiptFirst}`,receiptFirst?'98553':'98552');
      const request=await event(tenantId,runtimeConnectionId),confirmation=await event(tenantId,runtimeConnectionId);
      const prompt=await delivery(route,{origin:'BOT',finishedAt:new Date()});
      const row=command({conversation_id:route.id,request_event_id:request,confirmation_event_id:confirmation,confirmation_prompt_delivery_id:prompt});
      await worker(()=>insert(tables[1],row));
      const controller=new ZammadTicketStateController({withTenant:async(scope,action)=>{
        assert.equal(scope,tenantId);return app(()=>action(client));
      }},{verify:async()=>({tenantId,instanceId})});
      const transitionTime=new Date(Date.now()+1000).toISOString();
      const ordinary={tenant_id:tenantId,ticket_id:route.ticketId,state_id:4,state_name:'closed',state_type_name:'closed',transitioned_at:transitionTime,idempotency_key:`${prefix}-held-${row.id}`};
      assert.equal((await controller.ticketState(undefined,ordinary.idempotency_key,'direct-close-held',ordinary)).state,'BLOCKED_EFFECTS');
      const leaseId=randomUUID();await worker(()=>update(tables[1],row.id,{lease_id:leaseId,lease_expires_at:new Date(Date.now()+60000),fencing_token:1}));
      const snapshot=await worker(()=>prepareDirectCustomerClose(client,{tenantId,instanceId,commandId:row.id,leaseId,fencingToken:1,
        context:{updated_at:new Date().toISOString(),state_id:'2',last_article_id:'985531',native_group_id:'2',connection_id:runtimeConnectionId,external_chat_id:route.chatId,customer_id:'77',closed:false}}));
      assert.equal(snapshot.human_ownership_epoch,2);assert.equal(snapshot.conversation_fencing_token,7);
      assert.equal((await app(()=>directCustomerCloseAdmission(client,{tenantId,instanceId,commandId:row.id}))).effects_clear,true);
      await trial(async()=>{
        await app(()=>client.query('UPDATE bot_conversations SET human_ownership_epoch=3 WHERE id=$1',[route.id]));
        await applicationRejects('runtime: stale customer-close epoch rejected',/DIRECT_CLOSE_CONVERSATION_CHANGED/,()=>app(()=>directCustomerCloseAdmission(client,{tenantId,instanceId,commandId:row.id})));
      });
      if(receiptFirst){
        await worker(()=>update(tables[1],row.id,{state:'OUTCOME_UNKNOWN',lease_id:null,lease_expires_at:null}));
        const unknown=await app(()=>directCustomerCloseAdmission(client,{tenantId,instanceId,commandId:row.id}));
        assert.equal(unknown.native_action_state,'OUTCOME_UNKNOWN');assert.equal(unknown.effects_clear,false,'unknown permits receipt lookup, not another native mutation');
      }
      const receipt={state:'SUCCEEDED',command_id:row.id,ticket_id:route.ticketId,article_id:'985539',request_sha256:hash,
        closed_at:transitionTime,customer_id:'77',human_ownership_epoch:2,conversation_fencing_token:7};
      const record=()=>worker(()=>recordDirectCloseReceipt(client,{tenantId,commandId:row.id,receipt}));
      if(receiptFirst)await record();
      await applicationRejects('runtime: close remains held until callback projection',/DIRECT_NATIVE_EFFECT_HOLD/,
        ()=>app(()=>assertDirectNativeBarrier(client,{tenantId,conversationId:route.id})));
      const body={...ordinary,idempotency_key:`${prefix}-confirmed-${row.id}`,customer_close_receipt:receipt};
      const applied=await controller.ticketState(undefined,body.idempotency_key,'direct-close-confirmed',body);assert.equal(applied.state,'APPLIED');
      assert.deepEqual((await client.query('SELECT state,resolution_kind,human_ownership_epoch::int AS epoch,fencing_token::int AS fence FROM bot_conversations WHERE id=$1',[route.id])).rows[0],
        {state:'RESOLVED',resolution_kind:'CUSTOMER_CONFIRMED',epoch:2,fence:8});
      assert.equal((await client.query('SELECT state FROM direct_customer_close_commands WHERE id=$1',[row.id])).rows[0].state,'SUCCEEDED');
      assert.deepEqual(await record(),receipt);
      assert.equal((await controller.ticketState(undefined,body.idempotency_key,'direct-close-replay',body)).duplicate,true);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM bot_conversation_events WHERE conversation_id=$1 AND event_kind='RESOLVED'",[route.id])).rows[0].n,1);
      await app(()=>assertDirectNativeBarrier(client,{tenantId,conversationId:route.id}));
    }));
  } finally {
    await client.query('ROLLBACK');
    for (const table of [...tables,'bot_conversations']) {
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE id=ANY($1::uuid[])`,
        [[nativeId,commandId,conversationId,closeConversationId]])).rows[0].count,0,`${table} fixture rollback`);
    }
  }
  return {passed:checks.length,failed:0,rollback:true,checks};
}
