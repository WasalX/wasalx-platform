import assert from 'node:assert/strict';

export async function findRuleSet(request,id){let before;for(;;){const rows=await request('/api/rule-sets?limit=200'+(before?'&before='+encodeURIComponent(before):''));assert(Array.isArray(rows));const found=rows.find(row=>row.id===id);if(found)return found;if(rows.length<200)throw Error('Rule-set not found in complete catalog');const next=rows.at(-1)?.id;assert(next&&next!==before,'Rule-set catalog cursor did not advance');before=next;}}

function classifySyntheticRequestFailure(error){
  const message=String(error?.message??'');
  const http=message.match(/Seed request [A-Z]+ .*: HTTP ([45]\d{2})/u);
  if(http)return{code:'api-http',httpStatus:Number(http[1])};
  if(message.includes('Origin changed'))return{code:'page-origin-changed'};
  if(message.includes('Authenticated server page unavailable'))return{code:'authenticated-page-unavailable'};
  if(message.includes('Authenticated page CSRF unavailable or ambiguous'))return{code:'csrf-unavailable'};
  if(message.includes('Unsupported server chunk'))return{code:'server-chunk-unsupported'};
  if(/Execution context was destroyed|navigation|Target page.*closed/iu.test(message))return{code:'page-context-lost'};
  if(/Failed to fetch|NetworkError|net::ERR/iu.test(message))return{code:'network-transport'};
  if(/TimeoutError|timed out/iu.test(message))return{code:'timeout'};
  return{code:'unclassified-evaluate-error'};
}

export function createSyntheticRequest({page,origin,runId,checkpoint,receipts=[]}) {
  const request = async (path, method = 'GET', body, step) => {
    const key = step ? `synthetic-${runId}-${step}` : undefined;
    if (step) await checkpoint({phase:'intent', step, path, method, key});
    let result;
    try { result = await page.evaluate(async ({origin,path,method,body,key}) => {
      if (location.origin !== origin) throw Error('Origin changed');
      // Vinext embeds server props in its navigation runtime; keep private values in browser memory.
      // Keep CSRF in browser memory; never return it or serialize Flight content.
      let csrf;
      if (method !== 'GET') {
      const htmlResponse=await fetch('/app',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});
      if(!htmlResponse.ok || new URL(htmlResponse.url).pathname!=='/app') throw Error('Authenticated server page unavailable');
      const doc=new DOMParser().parseFromString(await htmlResponse.text(),'text/html');
      const prefix='((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]}).rsc.push(';
      const chunks=[...doc.scripts].map(s=>s.textContent).filter(s=>s.startsWith(prefix)).map(s=>JSON.parse(s.slice(prefix.length,-1)));
      const bytes=chunks.map(c=>typeof c==='string'?new TextEncoder().encode(c):Array.isArray(c)&&c[0]===3?Uint8Array.from(atob(c[1]),x=>x.charCodeAt(0)):(()=>{throw Error('Unsupported server chunk');})());
      const joined=new Uint8Array(bytes.reduce((n,b)=>n+b.length,0));let offset=0;for(const b of bytes){joined.set(b,offset);offset+=b.length;}
      const flight=new TextDecoder('utf-8',{fatal:true}).decode(joined);
        const values = [...flight.matchAll(/"csrfToken":"([^"\\]+)"/g)].map(x => x[1]);
        const unique = [...new Set(values)];
        if (unique.length !== 1) throw Error('Authenticated page CSRF unavailable or ambiguous; refresh owned /app page');
        csrf = unique[0];
      }
      const response = await fetch(path, {method, credentials:'same-origin', cache:'no-store',
        headers:{accept:'application/json', ...(method === 'GET' ? {} : {'content-type':'application/json'}),
          ...(csrf ? {'x-wasalx-csrf':csrf} : {}), ...(key ? {'idempotency-key':key} : {})},
        body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw Error(`Seed request ${method} ${path}: HTTP ${response.status}; reconcile intent before retry`);
      return response.json();
    }, {origin,path,method,body,key});
    } catch(error) {
      let pageOriginMatchesAtCatch=null;
      try { pageOriginMatchesAtCatch=new URL(page.url()).origin===origin; } catch {/* Browser may already be closed. */}
      try { await checkpoint({phase:'synthetic-request-failed',step:step??null,method,
        ...classifySyntheticRequestFailure(error),pageOriginMatchesAtCatch}); }
      catch {/* Preserve the original failure. */}
      throw error;
    }
    if (step) { const id=result.resultId??result.id??null;receipts.push({step,key,id}); await checkpoint({phase:'accepted',step,key,id}); }
    return result;
  };
  return request;
}

// Isolated simulation only. Caller owns/authenticates page and verifies runtime isolation.
// No CLI auto-run; no credential output; mutation timeouts are never retried here.
export async function seedSyntheticGroup({page, origin, runId, externalGroupId,
  nativeGroupName, evidenceMode, assertIsolatedRuntime, checkpoint, resumeConnection, resumeRule,
  request: injectedRequest, assertRequestActor, prepareOnly=false}) {
  if (typeof prepareOnly!=='boolean') throw Error('Invalid seed preparation mode');
  if (evidenceMode !== 'simulated' || !/^[a-zA-Z0-9_-]{1,60}$/.test(runId)) throw Error('Invalid simulated seed admission');
  if (!externalGroupId || !nativeGroupName || (!injectedRequest && new URL(page.url()).origin !== origin)) throw Error('Owned page/seed mismatch');
  if (injectedRequest && (typeof injectedRequest !== 'function' || typeof assertRequestActor !== 'function')) throw Error('Injected requests require actual actor admission');
  if (typeof checkpoint !== 'function' || typeof assertIsolatedRuntime !== 'function') throw Error('Admission and private checkpoint callbacks required');
  // Must verify Compose identity, synthetic tenant and simulator-only provider egress.
  await assertIsolatedRuntime({origin, evidenceMode});
  const receipts = [];
  // Injected capability owns real authentication/CSRF and the same stable step key.
  // It attests the actual actor/workspace; no Page substitute is accepted.
  if (injectedRequest) await assertRequestActor({origin,evidenceMode,runId});
  const request = injectedRequest ? async(path,method='GET',body,step)=>{
    const key=step?`synthetic-${runId}-${step}`:undefined;
    if(step)await checkpoint({phase:'intent',step,path,method,key});
    const result=await injectedRequest(path,method,body,step);
    if(step){const id=result.resultId??result.id??null;receipts.push({step,key,id});await checkpoint({phase:'accepted',step,key,id});}
    return result;
  } : createSyntheticRequest({page,origin,runId,checkpoint,receipts});
  const poll = async (read, accept) => {
    const deadline = Date.now()+120000;
    while (Date.now()<deadline) { const value=await read(); if(accept(value)) return value; await new Promise(r=>setTimeout(r,1000)); }
    throw Error('Seed readiness deadline; preserve intents and reconcile, do not recreate');
  };
  let connectionId;
  if (resumeConnection) {
    if (!/^[a-f0-9-]{36}$/i.test(resumeConnection.id) || typeof resumeConnection.name !== 'string') throw Error('Invalid resume identity');
    connectionId=resumeConnection.id;
    const existing=await request(`/api/connections/${connectionId}`);
    if(existing.name!==resumeConnection.name || existing.provider!=='WAHA' || !['FAILED_TERMINAL','SUCCEEDED'].includes(existing.latest_operation_state)) throw Error(`Resume requires reconciled terminal connection: nameMatched=${existing.name===resumeConnection.name}, provider=${existing.provider}, operation=${existing.latest_operation_state}, state=${existing.state}`);
    await checkpoint({phase:'resume',step:'connection',id:connectionId});
    if(existing.provider_state!=='WORKING') {
      if(['AWAITING_AUTH','CONNECTING','WORKING','DEGRADED'].includes(existing.state)) {
        await request(`/api/connections/${connectionId}/restart`,'POST',{},'restart');
        const recovered=await poll(()=>request(`/api/connections/${connectionId}`),d=>['FAILED_TERMINAL','SUCCEEDED'].includes(d.latest_operation_state));
        if(recovered.latest_operation_state==='FAILED_TERMINAL' && !['FAILED','ACTION_REQUIRED','PAUSED'].includes(recovered.state)) throw Error('Recovery did not reach a supported Start state');
        if(recovered.latest_operation_state==='FAILED_TERMINAL') await request(`/api/connections/${connectionId}/start`,'POST',{},'start');
      } else await request(`/api/connections/${connectionId}/start`,'POST',{},'start');
    }
  } else {
    const created = await request('/api/connections','POST',{name:`Synthetic ${runId}`,provider:'WAHA',engine:'GOWS',disclosureAccepted:true,disclosureVersion:'2026-08-09'},'connection');
    connectionId = created.id;
    if (!connectionId || !created.operation?.id) throw Error('Unexpected connection operation response');
  }
  const detail = () => request(`/api/connections/${connectionId}`);
  const settled = await poll(detail, d => {
    if (['FAILED_TERMINAL','CANCELLED'].includes(d.latest_operation_state)) throw Error('Connection operation failed');
    return d.latest_operation_state === 'SUCCEEDED';
  });
  if (settled.provider_state !== 'WORKING') await poll(detail,d=>d.provider_state==='WORKING' && d.latest_operation_state==='SUCCEEDED');
  // Explicit supported discovery, once. Simulator accepts generated wx_ session names.
  const sync = await request(`/api/connections/${connectionId}/groups/sync`,'POST',{},'sync');
  await poll(detail,d=>d.latest_operation_id===sync.operation?.id && d.latest_operation_state==='SUCCEEDED');
  const group = await poll(async()=>{
    const rows=await request(`/api/groups?connection=${encodeURIComponent(connectionId)}`);
    const matches=rows.filter(r=>r.connection_id===connectionId && r.external_group_id===externalGroupId);
    if(matches.length>1) throw Error('Ambiguous synthetic group'); return matches[0];
  },Boolean);
  const rule = resumeRule ?? await request('/api/rules','POST',{name:`Synthetic ${runId}`,matcherType:'exact_length',pattern:'[0-9]{10}',digitLength:10,priority:1,enabled:true,
    savedExamples:[{name:'Positive',message:'ID 1234567890',expectedMatches:['1234567890']}]},'rule');
  const draft=await findRuleSet(request,rule.id);
  if(!draft || !['DRAFT','ACTIVE'].includes(draft.state) || !Number.isSafeInteger(Number(draft.revision)) || Number(draft.revision)<1 || (resumeRule&&draft.name!==resumeRule.name)) throw Error('Unexpected rule identity/state/revision');
  if(draft.state==='DRAFT') await request(`/api/rule-sets/${rule.id}/activate`,'POST',{expectedRevision:Number(draft.revision),expectedActiveRuleSetId:null,expectedActiveRevision:null},'activate');
  if(prepareOnly){
    const active=await findRuleSet(request,rule.id);if(active.state!=='ACTIVE'||active.id!==rule.id||!Number.isSafeInteger(Number(active.revision))||Number(active.revision)<1)throw Error('Prepared rule did not remain active');
    return{evidenceMode,preparationOnly:true,connectionId,connectionName:settled.name,groupId:group.id,groupRef:externalGroupId,nativeGroupName,ruleSetId:rule.id,ruleName:active.name,ruleRevision:Number(active.revision),ruleSnapshotSha256:active.snapshot_sha256,receipts};
  }
  const bound=await bindSyntheticGroup(request,{groupId:group.id,ruleSetId:rule.id,nativeGroupName});
  return {evidenceMode,connectionId,groupId:group.id,ruleSetId:rule.id,...bound,receipts};
}

async function bindSyntheticGroup(request,{groupId,ruleSetId,nativeGroupName,nativeGroupId,freshOnly=false}){
  const catalogs=await request('/api/zammad/routing-catalogs');
  const targets=catalogs.groups.filter(g=>g.name===nativeGroupName&&g.active&&g.serviceIdentityCanCreate&&(nativeGroupId===undefined||String(g.id)===String(nativeGroupId)));
  if(targets.length!==1)throw Error('Synthetic native group is not uniquely authorized');
  const current=await request(`/api/groups/${groupId}/binding`);
  if(freshOnly&&current.binding_id)throw Error('Prepared binding already changed; preserve original intent');
  if(current.binding_id&&(current.rule_set_id!==ruleSetId||current.binding_state!=='ACTIVE'))throw Error('Existing binding conflicts with resumed scenario');
  if(!current.binding_id)await request(`/api/groups/${groupId}/binding`,'PUT',{ruleSetId,zammadGroupId:targets[0].id,acknowledgementTemplate:'Received',agentPrefix:'Agent',defaultPriority:'normal',assignmentMode:'zammad_auto',businessHoursMode:'ALWAYS',agentIdentityPlacement:'HEADER',maxIdentifiers:20,mediaEnabled:true,retentionDays:30,state:'ACTIVE',expectedRevision:0},'bind');
  const bound=await request(`/api/groups/${groupId}/binding`);if(bound.binding_state!=='ACTIVE'||bound.rule_set_id!==ruleSetId||nativeGroupId!==undefined&&String(bound.zammad_group_id)!==String(nativeGroupId))throw Error('Binding readback mismatch');
  return{bindingId:bound.binding_id,bindingRevision:bound.binding_revision};
}

export async function bindPreparedSyntheticGroup({page,origin,runId,prepared,nativeGroupId,checkpoint,assertIsolatedRuntime}){
  if(prepared?.evidenceMode!=='simulated'||prepared.preparationOnly!==true||!Number.isSafeInteger(prepared.ruleRevision)||prepared.ruleRevision<1)throw Error('Exact prepared fixture required');
  if(!/^[1-9][0-9]{0,15}$/u.test(String(nativeGroupId))||new URL(page.url()).origin!==origin)throw Error('Reviewed native target required');
  await assertIsolatedRuntime({origin,evidenceMode:'simulated'});
  const receipts=[],request=createSyntheticRequest({page,origin,runId,checkpoint,receipts});
  const connection=await request('/api/connections/'+prepared.connectionId);if(connection.name!==prepared.connectionName||connection.provider!=='WAHA'||connection.provider_state!=='WORKING'||connection.latest_operation_state!=='SUCCEEDED')throw Error('Prepared connection changed');
  const groups=await request('/api/groups?connection='+encodeURIComponent(prepared.connectionId)),matches=groups.filter(row=>row.id===prepared.groupId&&row.connection_id===prepared.connectionId&&row.external_group_id===prepared.groupRef);if(matches.length!==1)throw Error('Prepared group changed');
  const rule=await findRuleSet(request,prepared.ruleSetId);if(rule.name!==prepared.ruleName||rule.state!=='ACTIVE'||Number(rule.revision)!==prepared.ruleRevision||rule.snapshot_sha256!==prepared.ruleSnapshotSha256)throw Error('Prepared rule changed');
  const bound=await bindSyntheticGroup(request,{groupId:prepared.groupId,ruleSetId:prepared.ruleSetId,nativeGroupName:prepared.nativeGroupName,nativeGroupId,freshOnly:true});
  return{evidenceMode:'simulated',connectionId:prepared.connectionId,groupId:prepared.groupId,ruleSetId:prepared.ruleSetId,...bound,receipts:[...prepared.receipts,...receipts]};
}
