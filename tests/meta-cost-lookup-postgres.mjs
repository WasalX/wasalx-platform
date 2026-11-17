import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {Client} from 'pg';

// PRIVATE, UNEXECUTED SOURCE PROPOSAL. No managed authority is created here.
// Called by the canonical PG helper only after P08's actual domain fixture has
// produced the account, immutable terms, successful effects and privacy targets.
// Each config is a real runtime login, never an admin login plus SET ROLE.
const sha = value => createHash('sha256').update(value).digest('hex');
const names = new Set(['tenants','privacy_jobs','delivery_outbox','delivery_attempts',
  'delivery_receipts','meta_messaging_accounts','meta_connection_account_bindings',
  'meta_billing_policy_versions','meta_cost_tariff_versions','meta_cost_assessments',
  'platform_operations_audit_events','platform_metering_operator_requests']);
const quote = value => '"' + value.replaceAll('"','""') + '"';

async function fresh(config, role, fn) {
  const client = new Client({...config, statement_timeout:10000, query_timeout:12000});
  await client.connect();
  try {
    const identity = (await client.query(`SELECT session_user,current_user,
      pg_has_role(current_user,$1,'MEMBER') AS allowed,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=session_user) AS privileged`,[role])).rows[0];
    assert.equal(identity.allowed,true);
    assert.equal(identity.privileged,false,'A real restricted runtime login is required');
    await client.query('BEGIN');
    try { return await fn(client); }
    finally { await client.query('ROLLBACK'); }
  } finally { await client.end(); }
}

async function tenant(client, id) {
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[id]);
}

async function rejected(client, action, code) {
  await client.query('SAVEPOINT expected_rejection');
  try { await assert.rejects(action,error=>error.code===code); }
  finally { await client.query('ROLLBACK TO SAVEPOINT expected_rejection'); }
}

// Catalog-only administrator read obtains the installed real column types. It
// does not call an affected function or seed a public authority row. Restricted
// clients create their own TEMP shadows and deliberately grant the definer read
// access, so permission failure cannot masquerade as a lookup protection PASS.
export async function metaCostShadowDefinitions(admin) {
  const result = {};
  for (const name of names) {
    const columns=(await admin.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[name])).rows;
    assert(columns.length>0,`Missing real dependency ${name}`);
    result[name]=columns.map(column=>`${quote(column.attname)} ${column.type}`).join(',');
  }
  return result;
}

async function shadows(client, definitions, selected) {
  for (const name of selected) {
    assert(names.has(name));
    await client.query(`CREATE TEMP TABLE ${quote(name)} (${definitions[name]}) ON COMMIT DROP`);
    await client.query(`GRANT SELECT ON pg_temp.${quote(name)} TO PUBLIC`);
  }
}

async function fake(client,name,row) {
  assert(names.has(name));
  await client.query(`INSERT INTO pg_temp.${quote(name)} SELECT (pg_catalog.jsonb_populate_record(NULL::pg_temp.${quote(name)},$1::jsonb)).*`,[JSON.stringify(row)]);
}

const action = (client,scope,kind,object,body,key=randomUUID()) => client.query(
  'SELECT app.operator_meta_cost($1,$2,$3,$4,$5,$6,$7) AS value',
  [kind,scope.tenantId,object,body,key,'synthetic-cost-operator',randomUUID()]).then(result=>result.rows[0].value);
const read = (client,scope) => client.query(
  'SELECT app.operator_meta_cost_read($1,$2,$3,$4,$5,$6) AS value',
  [scope.tenantId,scope.accountId,scope.from,scope.to,'synthetic-cost-operator',randomUUID()]).then(result=>result.rows[0].value);

export async function verifyMetaCostTimezoneLookup({platformConfig,definitions,scope,definition}) {
  assert.equal(definition.tenantId,scope.tenantId); assert.equal(definition.accountId,scope.accountId);
  assert.equal(definition.purpose,'UPSTREAM_REFERENCE'); assert.equal(definition.evidenceMode,'SIMULATED');
  // Separate physical sessions: both hostile relations exist before the first
  // compilation/execution of the tariff validator in each session.
  await fresh(platformConfig,'wasalx_platform_operations_client',async client=>{
    await client.query('CREATE TEMP TABLE pg_timezone_names(name text) ON COMMIT DROP');
    await client.query('GRANT SELECT ON pg_temp.pg_timezone_names TO PUBLIC');
    await shadows(client,definitions,['tenants','meta_messaging_accounts','privacy_jobs',
      'meta_cost_tariff_versions','platform_metering_operator_requests','platform_operations_audit_events']);
    const created=await action(client,scope,'META_COST_DRAFT',null,{definition:{...definition,timezone:'UTC'},supersedesId:null});
    assert.equal(created.state,'DRAFT');
    const actual=await read(client,scope);
    assert(actual.tariffs.some(row=>row.id===created.id),'Real scoped draft survives empty public-table shadows');
  });
  await fresh(platformConfig,'wasalx_platform_operations_client',async client=>{
    await client.query('CREATE TEMP TABLE pg_timezone_names(name text) ON COMMIT DROP');
    await client.query('GRANT SELECT ON pg_temp.pg_timezone_names TO PUBLIC');
    await client.query("INSERT INTO pg_temp.pg_timezone_names VALUES('WasalX/Invented_Timezone')");
    const before=await read(client,scope);
    await rejected(client,()=>action(client,scope,'META_COST_DRAFT',null,
      {definition:{...definition,timezone:'WasalX/Invented_Timezone'},supersedesId:null}),'22023');
    const after=await read(client,scope);
    assert.deepEqual(after.tariffs,before.tariffs,'Invalid zone persists no version');
  });
}

export async function verifyMetaCostScopedLookup({appConfig,workerConfig,platformConfig,definitions,scope,foreignTenantId,effect}) {
  assert.equal(effect.tenantId,scope.tenantId);
  assert.equal(effect.accountId,scope.accountId);
  const shadowNames=['delivery_outbox','delivery_attempts','delivery_receipts','meta_messaging_accounts',
    'meta_connection_account_bindings','meta_billing_policy_versions','meta_cost_tariff_versions','meta_cost_assessments',
    'platform_operations_audit_events'];
  await fresh(appConfig,'wasalx_app',async client=>{
    await shadows(client,definitions,shadowNames); await tenant(client,scope.tenantId);
    const rows=(await client.query('SELECT app.meta_cost_usage_snapshot($1,$2,$3,$4) AS value',
      [scope.tenantId,scope.accountId,scope.from,scope.to])).rows[0].value;
    assert.equal(rows.complete,true);
    assert(rows.rows.some(row=>row.deliveryId===effect.deliveryId),'Actual assessed effect cannot be hidden by empty shadows');
    assert((await client.query('SELECT app.meta_cost_accounts($1) AS value',[scope.tenantId])).rows[0].value.some(row=>row.id===scope.accountId));
    await tenant(client,foreignTenantId);
    assert.equal((await client.query('SELECT app.meta_cost_usage_snapshot($1,$2,$3,$4) AS value',
      [scope.tenantId,scope.accountId,scope.from,scope.to])).rows[0].value.selectedCount,0);
    await rejected(client,()=>action(client,scope,'META_COST_REASSESS',scope.accountId,{items:[],purpose:'UPSTREAM_REFERENCE'}),'42501');
  });
  await fresh(workerConfig,'wasalx_connector_worker',async client=>{
    await shadows(client,definitions,shadowNames); await tenant(client,scope.tenantId);
    const before=(await client.query('SELECT id,input_sha256 FROM public.meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY id',
      [scope.tenantId,effect.deliveryId])).rows;
    const historical=(await client.query('SELECT app.resolve_meta_message_effect($1,$2,$3) AS value',
      [scope.tenantId,effect.deliveryId,effect.externalMessageId])).rows[0].value;
    assert.equal(historical.state,'ATTRIBUTED'); assert.equal(historical.effect.attemptId,effect.attemptId);
    assert.equal(historical.admission.execution.mode,'SIMULATED');
    await client.query('SELECT app.assess_meta_delivery_cost($1)',[effect.deliveryId]);
    assert.deepEqual((await client.query('SELECT id,input_sha256 FROM public.meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY id',
      [scope.tenantId,effect.deliveryId])).rows,before,'Idempotent real assessment uses authoritative receipt/attempt/tariff history');
    await rejected(client,()=>client.query('DELETE FROM public.meta_cost_assessments WHERE tenant_id=$1',[scope.tenantId]),'42501');
  });
  await fresh(platformConfig,'wasalx_platform_operations_client',async client=>{
    await shadows(client,definitions,['tenants','privacy_jobs','platform_metering_operator_requests',...shadowNames]);
    const actual=await read(client,scope);
    assert(actual.rows.some(row=>row.deliveryId===effect.deliveryId));
    assert(actual.tariffs.some(row=>row.id===effect.customerTariffId&&row.accepted_policies.some(policy=>policy.id===effect.policyVersionId)),
      'Historical accepted tariff projection uses the real immutable terms/policy pair');
    await rejected(client,()=>client.query('SELECT * FROM public.meta_cost_assessments'),'42501');
  });
}

export async function verifyMetaCostForgedLookup({appConfig,workerConfig,platformConfig,definitions,scope,effect,publicRows,expectedSnapshot}) {
  // The canonical fixture administrator supplies only its own actual rows;
  // installed in TEMP below, never written to the authority tables. This also
  // detects accidental temp-first lookup in a transitive P08 resolver/terms read.
  const selected=Object.keys(publicRows);
  assert(selected.includes('meta_cost_assessments'));
  assert(selected.includes('meta_cost_tariff_versions'));
  assert(selected.includes('delivery_attempts'));
  const install=async client=>{
    await shadows(client,definitions,selected);
    for(const name of selected) for(const original of publicRows[name]) {
      const row=structuredClone(original);
      if(name==='meta_cost_assessments') { row.amount='999999999.99'; row.unrounded_amount='999999999.99'; row.evidence_mode='LIVE'; }
      if(name==='meta_cost_tariff_versions') {
        row.evidence_mode='LIVE'; row.definition={...row.definition,evidenceMode:'LIVE',rates:row.definition.rates.map(rate=>({...rate,unitPrice:'999999999.99'}))};
      }
      if(name==='delivery_attempts'&&row.meta_billing_admission?.execution)row.meta_billing_admission.execution.mode='LIVE';
      if(name==='meta_billing_policy_versions')row.account_id=randomUUID();
      if(name==='platform_operations_audit_events')row.safe_metadata={...row.safe_metadata,evidenceMode:'LIVE',accountId:randomUUID()};
      await fake(client,name,row);
    }
  };
  await fresh(appConfig,'wasalx_app',async client=>{
    await install(client); await tenant(client,scope.tenantId);
    const value=(await client.query('SELECT app.meta_cost_usage_snapshot($1,$2,$3,$4) AS value',
      [scope.tenantId,scope.accountId,scope.from,scope.to])).rows[0].value;
    assert.deepEqual(value,expectedSnapshot,'Forged TEMP amounts/mode cannot enter a scoped snapshot');
  });
  await fresh(workerConfig,'wasalx_connector_worker',async client=>{
    await install(client); await tenant(client,scope.tenantId);
    const before=(await client.query('SELECT id,input_sha256 FROM public.meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY id',
      [scope.tenantId,effect.deliveryId])).rows;
    await client.query('SELECT app.assess_meta_delivery_cost($1)',[effect.deliveryId]);
    assert.deepEqual((await client.query('SELECT id,input_sha256 FROM public.meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY id',
      [scope.tenantId,effect.deliveryId])).rows,before);
  });
  await fresh(platformConfig,'wasalx_platform_operations_client',async client=>{
    await install(client);
    const value=await read(client,scope);
    const {tariffs,accounts,...snapshot}=value;
    assert.deepEqual(snapshot,expectedSnapshot);
    assert(accounts.some(row=>row.id===scope.accountId));
    const accepted=tariffs.find(row=>row.id===effect.customerTariffId);
    assert.equal(accepted.definition.evidenceMode,'SIMULATED');
    assert(accepted.accepted_policies.some(row=>row.id===effect.policyVersionId));
  });
}

export async function verifyMetaCostSchemaPrivileges({appConfig,workerConfig,platformConfig}) {
  for(const[config,role]of [[appConfig,'wasalx_app'],[workerConfig,'wasalx_connector_worker'],[platformConfig,'wasalx_platform_operations_client']]) {
    await fresh(config,role,async client=>{
      await rejected(client,()=>client.query('CREATE TABLE public.p10_forbidden_create(id integer)'),'42501');
      await rejected(client,()=>client.query('CREATE TABLE app.p10_forbidden_create(id integer)'),'42501');
      await client.query('CREATE TEMP TABLE p10_permitted_temp(id integer) ON COMMIT DROP');
      await client.query('INSERT INTO pg_temp.p10_permitted_temp VALUES(1)');
      assert.equal((await client.query('SELECT id FROM pg_temp.p10_permitted_temp')).rows[0].id,1);
      for(const table of ['meta_cost_tariff_versions','meta_cost_assessments']) {
        const privileges=(await client.query(`SELECT has_table_privilege(current_user,$1,'INSERT') AS ins,
          has_table_privilege(current_user,$1,'UPDATE') AS upd,has_table_privilege(current_user,$1,'DELETE') AS del`,[`public.${table}`])).rows[0];
        assert.deepEqual(privileges,{ins:false,upd:false,del:false});
      }
    });
  }
}

export async function verifyMetaReceiptLookup({workerConfig,definitions,scope,unredactedReceipt,redactedReceipt,unredactedDelivery,redactedDelivery}) {
  assert.equal(unredactedReceipt.external_message_id!==null,true);
  assert.equal(unredactedDelivery.content_redacted_at,null);
  assert.notEqual(redactedDelivery.content_redacted_at,null);
  // Original rows are read by the canonical administrator only after P08's real
  // effect and the real leased privacy workflow. Copies below are TEMP attacks.
  await fresh(workerConfig,'wasalx_connector_worker',async client=>{
    await shadows(client,definitions,['delivery_outbox']); await tenant(client,scope.tenantId);
    await fake(client,'delivery_outbox',{...unredactedDelivery,content_redacted_at:new Date().toISOString()});
    await rejected(client,()=>client.query('UPDATE public.delivery_receipts SET external_message_id=NULL WHERE tenant_id=$1 AND id=$2',
      [scope.tenantId,unredactedReceipt.id]),'42501');
  });
  await fresh(workerConfig,'wasalx_connector_worker',async client=>{
    await shadows(client,definitions,['delivery_outbox']); await tenant(client,scope.tenantId);
    await fake(client,'delivery_outbox',{...redactedDelivery,content_redacted_at:null});
    const insert=async externalId=>{
      const candidate={...redactedReceipt,id:randomUUID(),external_message_id:externalId,receipt_key_sha256:sha(randomUUID())};
      return client.query('INSERT INTO public.delivery_receipts SELECT (pg_catalog.jsonb_populate_record(NULL::public.delivery_receipts,$1::jsonb)).*',[JSON.stringify(candidate)]);
    };
    await rejected(client,()=>insert('wamid.synthetic-forbidden-restoration'),'42501');
    // Actual redacted public row still permits a content-free late receipt.
    assert.equal((await insert(null)).rowCount,1);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
}

// Called inside the existing leased privacy finalizer's test transaction after
// its real delivery-redaction UPDATE, before its receipt UPDATE. The canonical
// helper installs the empty shadow on that fresh worker connection beforehand.
// This is a test callback around the real PG query, not a production API/hook.
export async function verifyMetaReceiptRedactionWindow(client,tenantId,receiptId) {
  const row=(await client.query(`SELECT receipt.external_message_id,delivery.content_redacted_at
    FROM public.delivery_receipts receipt JOIN public.delivery_outbox delivery
      ON delivery.tenant_id=receipt.tenant_id AND delivery.id=receipt.delivery_id
    WHERE receipt.tenant_id=$1 AND receipt.id=$2`,[tenantId,receiptId])).rows[0];
  assert(row?.external_message_id); assert(row.content_redacted_at);
  assert.equal((await client.query('UPDATE public.delivery_receipts SET external_message_id=NULL WHERE tenant_id=$1 AND id=$2',
    [tenantId,receiptId])).rowCount,1,'Real authorized redaction cannot be hidden by an empty TEMP relation');
}
