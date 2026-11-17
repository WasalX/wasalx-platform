// Proposal: caller supplies isolated, already authenticated pages and a dedicated DB client.
// No live credentials, SQL fixture writes, browser creation, or automatic retries.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createSyntheticRequest} from './seed-simulation-group.mjs';

const journey='cases-deliveries/case-filter-generation-and-detach';
const business=`${journey}::case-filter-generation-and-detach-update-the-list`;
export const testIds=[...['01','02','03','04'].map(n=>`${business}::${n}`)];

export function assertSuccessor(before,after){
  assert.equal(after.length,before.length+1);
  const previous=before.find(r=>!r.replaced_by_correlation_id && r.state!=='DETACHED');
  assert(previous,'Exactly scoped current predecessor is required');
  const retained=after.find(r=>r.id===previous.id);
  const next=after.find(r=>r.predecessor_correlation_id===previous.id);
  assert(next); assert.equal(Number(next.generation),Number(previous.generation)+1);
  assert.notEqual(next.zammad_ticket_id,previous.zammad_ticket_id);
  assert.equal(retained.state,'DETACHED'); assert.equal(retained.replaced_by_correlation_id,next.id);
  for(const old of before)assert(after.some(r=>r.id===old.id && r.zammad_ticket_id===old.zammad_ticket_id));
  return next;
}

export function assertNativeEffects(before,after,nextTicketId){
  assert.equal(before.markerArticles.length,0,'Next marker already exists; reconcile original action');
  const previous=new Set(before.ticketIds.map(String));
  assert.equal(previous.size,before.ticketIds.length);
  assert.equal(after.ticketIds.length,before.ticketIds.length+1,'Exactly one native ticket must be added');
  assert(before.ticketIds.every(id=>after.ticketIds.map(String).includes(String(id))));
  assert.deepEqual(after.ticketIds.filter(id=>!previous.has(String(id))).map(String),[String(nextTicketId)]);
  assert.equal(after.markerArticles.length,1,'Exactly one native marker article must exist');
  assert.equal(String(after.markerArticles[0].ticket_id),String(nextTicketId));
}

export async function runCaseLifecycle({page,db,origin,tenantId,connectionId,bindingId,
  reference,runId,control,drainEffects,nextInput,candidate,evidencePath,checkpoint,assertAdmission,readNativeEffects}){
  assert(/^\d{10}$/.test(reference)); assert(nextInput.text.includes(reference));
  assert(/^[a-zA-Z0-9_-]{1,60}$/.test(runId));
  await assertAdmission({evidenceMode:'simulated',tenantId,bindingId,connectionId,candidate});
  assert.equal(typeof readNativeEffects,'function','Actual native DB effect readback required before dispatch');
  // Admission verifies dedicated group/reference ownership, true owner identity and recent MFA.
  const request=createSyntheticRequest({page,origin,runId,checkpoint});
  const startedAt=new Date().toISOString();
  const tenantQuery=async(sql,values)=>{
    await db.query('BEGIN READ ONLY');
    try{
      await db.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      return await db.query(sql,values);
    }finally{await db.query('ROLLBACK');}
  };
  const read=async()=>{
      return (await tenantQuery(`SELECT id,state,generation,version,zammad_ticket_id,zammad_ticket_number,detached_at,
        predecessor_correlation_id,replaced_by_correlation_id FROM case_correlations
        WHERE tenant_id=$1 AND group_binding_id=$2 AND normalized_reference=$3 ORDER BY generation,id`,[tenantId,bindingId,reference])).rows;
  };
  const before=await read();
  const nativeEffectsBefore=await readNativeEffects({connectionId,chatId:nextInput.chatId,reference,marker:nextInput.text});
  assert.equal(nativeEffectsBefore.markerArticles.length,0,'Retained native marker requires reconciliation');
  const current=before.filter(r=>r.state==='OPEN'&&!r.replaced_by_correlation_id);
  assert.equal(current.length,1,'Create one owned case through existing inbound scenario before admission');
  const target=current[0];
  await checkpoint({phase:'evidence',step:'before',before,nativeEffectsBefore});
  const preInbox=await tenantQuery(`SELECT id FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2
    AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'WAHA',$3)`,[tenantId,connectionId,nextInput.eventId]);
  assert.equal(preInbox.rows.length,0,'Retained event requires readback, never new dispatch');
  await page.goto(`${origin}/app?view=cases`);
  const search=page.getByRole('textbox',{name:'Search linked cases'});
  await search.fill(reference);
  const filter=page.getByRole('combobox',{name:'Filter by state'});
  const rowFor=ticket=>page.getByRole('row').filter({has:page.getByRole('link',{name:`Open support case #${ticket} in the agent workspace`,exact:true})});
  const prepare=rowFor(target.zammad_ticket_number).getByRole('button');
  await prepare.click();
  const dialog=page.getByRole('alertdialog');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await dialog.waitFor({state:'hidden'}); assert.deepEqual(await read(),before);
  await checkpoint({phase:'evidence',step:'cancel-unchanged',before});
  await prepare.click();
  const route=`**/api/cases/${target.id}/detach`;
  let capturedIntent;
  const intercept=async routed=>{
    const req=routed.request();
    assert.equal(req.method(),'POST');
    assert(!capturedIntent,'Repeated detach submission');
    capturedIntent={phase:'intent',step:'detach',correlationId:target.id,
      key:req.headers()['idempotency-key'],body:req.postDataJSON()};
    assert(capturedIntent.key); assert.equal(capturedIntent.body.expectedVersion,Number(target.version));
    await checkpoint(capturedIntent); // Durable before the application request leaves the browser.
    await routed.continue();
  };
  await page.route(route,intercept);
  try{
    const responsePromise=page.waitForResponse(r=>r.url().endsWith(`/api/cases/${target.id}/detach`)&&r.request().method()==='POST');
    await dialog.getByRole('button',{name:'End current link',exact:true}).click();
    const response=await responsePromise;
    assert(response.ok(),`Detach HTTP ${response.status()}; preserve intent; do not retry`);
    const receipt=await response.json(); assert.equal(receipt.id,target.id);
    await checkpoint({phase:'accepted',step:'detach',id:target.id,key:capturedIntent.key});
    await dialog.waitFor({state:'hidden'});
  }finally{await page.unroute(route,intercept);}
  const detached=await read(); assert.equal(detached.find(r=>r.id===target.id).state,'DETACHED');
  const audit=await tenantQuery("SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='case.correlation_detached'",[tenantId,target.id]);
  assert.equal(audit.rows[0].count,1);
  await checkpoint({phase:'evidence',step:'detached',detached,auditCount:audit.rows[0].count});
  await filter.selectOption('OPEN'); assert.equal(await rowFor(target.zammad_ticket_number).count(),0);
  await filter.selectOption('DETACHED');
  const detachedRow=rowFor(target.zammad_ticket_number);
  await detachedRow.waitFor({state:'visible'});
  const detachedWording=(await detachedRow.locator('td').nth(5).locator('small').innerText()).trim();
  assert.match(detachedWording,/^Link ended (?!in\b)/u,'Detached time must read as a past event');
  assert(detached.find(r=>r.id===target.id)?.detached_at,'Detached timestamp must persist');
  await checkpoint({phase:'evidence',step:'detached-wording',detachedWording});
  await checkpoint({phase:'intent',step:'next-generation',eventId:nextInput.eventId,messageId:nextInput.messageId});
  const emission=await control({action:'inbound',input:nextInput});
  assert(emission.results.length && emission.results.every(r=>r.status===202&&r.receipt?.accepted&&r.receipt.duplicate===false));
  await checkpoint({phase:'accepted',step:'next-generation',emission});
  let after,next,terminal;
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    after=await read();
    terminal=(await tenantQuery(`SELECT status,lease_id FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2
      AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'WAHA',$3)`,[tenantId,connectionId,nextInput.eventId])).rows;
    if(after.length===before.length+1&&terminal.length===1&&terminal[0].status==='PROCESSED'&&terminal[0].lease_id===null){next=assertSuccessor(before,after);break;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert(next,'Generation did not settle; retain original event and inspect before continuation');
  assert.equal(terminal.length,1);assert.equal(terminal[0].status,'PROCESSED');assert.equal(terminal[0].lease_id,null);
  await checkpoint({phase:'evidence',step:'generation',after,terminal});
  const exact=await request(`/api/cases?ticket=${encodeURIComponent(next.zammad_ticket_number)}`);
  assert.equal(exact.length,1); assert.equal(exact[0].id,next.id);
  await page.reload(); await search.fill(reference);
  await filter.selectOption('OPEN'); await rowFor(next.zammad_ticket_number).waitFor({state:'visible'});
  assert.equal(await rowFor(target.zammad_ticket_number).count(),0);
  await filter.selectOption('DETACHED'); await rowFor(target.zammad_ticket_number).waitFor({state:'visible'});
  assert.equal(await rowFor(next.zammad_ticket_number).count(),0);
  await filter.selectOption('ALL');
  await checkpoint({phase:'evidence',step:'filters-reload-exact',after,exact});
  await drainEffects();
  const nativeEffectsAfter=await readNativeEffects({connectionId,chatId:nextInput.chatId,reference,marker:nextInput.text});
  assertNativeEffects(nativeEffectsBefore,nativeEffectsAfter,next.zammad_ticket_id);
  await checkpoint({phase:'evidence',step:'native-effects',nativeEffectsBefore,nativeEffectsAfter});
  const native={id:next.zammad_ticket_id,number:next.zammad_ticket_number}; // Full exact navigation needs separate missing/unauthorized proof.
  const result={evidenceMode:'simulated',candidate,startedAt,finishedAt:new Date().toISOString(),testIds,
    status:'bounded-scenario-passed',before,detached,after,native,emission,auditCount:audit.rows[0].count,
    nativeEffectsBefore,nativeEffectsAfter,
    limitations:['Caller must bind actor/context and deployed image evidence','Native mobile remains a separate check','No full journey pass claimed']};
  await writeFile(evidencePath,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});return result;
}
