import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {observePortalAction,portalGroupCatalogBoundary,portalGroupResult,probePortalGroupMedia,groupOperation,findPortalTeamMember,updatePortalTicketState} from '../scripts/release/simulation-portal-groups.mjs';
import {filterPortalGroupTicket} from '../scripts/release/simulation-portal-group-ticket.mjs';
import {portalGroupSuccessors,portalGroupDefinitions,portalGroupContextRequirements,completePortalBusinessTestIds,portalGrantTestIds,portalGrantQualityIds,portalHistoryIds,portalPrivacyIds} from '../scripts/release/simulation-portal-group-definitions.mjs';
import {definitions} from '../scripts/release/simulation-native-group-definitions.mjs';
import {completeNativeBusinessTestIds} from '../scripts/release/simulation-native-business-stage.mjs';
import {nativeGrantTestIds,nativeGrantQualityIds} from '../scripts/release/simulation-native-grants-stage.mjs';
import {nativeHistoryIds,nativePrivacyIds} from '../scripts/release/simulation-native-history.mjs';
import {portalGroupContexts} from '../scripts/release/simulation-portal-group-stage.mjs';
import {portalBusinessStage} from '../scripts/release/simulation-portal-business-stage.mjs';
import {portalLifecycleStage} from '../scripts/release/simulation-portal-group-cross-connection.mjs';
import {portalGowsReceiptStage} from '../scripts/release/simulation-portal-business-stage.mjs';
import {groupTextReceiptTestId} from '../scripts/release/simulation-gows-receipt-stage.mjs';
import {observePortalUnreadWithHeldRead} from '../scripts/release/simulation-portal-group-history.mjs';
import {observeUploadFile} from '../scripts/release/simulation-native-media-ui.mjs';

const origin='https://portal.example',input={group_id:'group',request_token:'operation'},request=(operation,value=input,url=origin+'/api/inbox')=>({method:()=> 'POST',url:()=>url,postDataJSON:()=>({operation,input:value})});
class ActionPage extends EventEmitter{
 constructor({status=200}={}){super();this.status=status;this.continued=[];this.aborted=0;this.unrouted=0;}
 url(){return origin+'/app?view=inbox';}
 async route(_,handler){this.handler=handler;}
 async unroute(){this.unrouted++;this.handler=null;}
 async dispatch(operation='GROUP_SEND',value=input){
  const req=request(operation,value);await this.handler({request:()=>req,fallback:async()=>{},abort:async()=>{this.aborted++;},continue:async()=>{this.continued.push(req);this.emit('response',{url:()=>req.url(),request:()=>req,ok:()=>this.status===200,status:()=>this.status,text:async()=>JSON.stringify(this.status===200?{accepted:true}:{error:'Unavailable'})});}});
 }
}

class TicketPage extends ActionPage{
 constructor({receipt=intent=>({state:'APPLIED',operation_id:intent.operation_id,ticket_id:intent.ticket_id}),openedTicketId='52',intentTicketId='52',lost=false}={}){super();Object.assign(this,{receipt,openedTicketId,intentTicketId,lost,stateId:2,writes:[],category:'OPEN',selectedState:'2',currentUrl:origin+'/app',savedNotices:0});}
 url(){return this.currentUrl;}
 async goto(url){this.currentUrl=url;}
 async reload(){}
 async setViewportSize(){}
 viewportSize(){return{width:1440,height:1000};}
 locator(selector){return this.control(selector);}
 getByRole(role,options){return this.control(role,options);}
  control(kind,options={}){return{waitFor:async()=>{if(kind==='status')this.savedNotices++;},count:async()=>1,innerText:async()=> 'Owned group',filter:()=>this.control(kind,options),locator:selector=>this.control(selector),getByRole:(role,options)=>this.control(role,options),getByLabel:label=>this.control(label),selectOption:async value=>{if(kind==='#inbox-state')this.selectedState=value;else if(kind==='Ticket status')this.category=value;},click:async()=>{if(options?.name==='Save changes')await this.save();}};}
 async evaluate(_,input){const body=input?.body;assert.equal(input.path,'/api/inbox');if(body.operation==='LIST')return{items:[{id:this.openedTicketId,number:'77001',title:'Owned ticket'}]};if(body.operation==='GROUP_SHOW')return{id:body.input.group_id,name:'Owned group'};if(body.operation==='GROUP_TICKETS')return{items:[{ticket_number:'77001',state_category:body.input.state}],next_cursor:null};throw Error('Unexpected fake read operation '+body.operation);}
 async save(){const intent={ticket_id:this.intentTicketId,operation_id:`00000000-0000-4000-8000-${String(this.writes.length+1).padStart(12,'0')}`,state_id:this.selectedState},req=request('UPDATE',intent);
  await this.handler({request:()=>req,fallback:async()=>{},abort:async()=>{this.aborted++;},continue:async()=>{this.writes.push(intent);this.stateId=Number(intent.state_id);this.emit('response',{url:()=>req.url(),request:()=>req,ok:()=>true,status:()=>200,text:async()=>JSON.stringify(this.receipt(intent))});}});
  if(this.aborted)throw Error('Update blocked before dispatch');if(this.lost)throw Error('Update receipt lost after dispatch');
 }
}
function ticketOperator(page){
 const container={Id:'a'.repeat(64),Image:'sha256:fixed',State:{Status:'running'},Config:{Labels:{'com.docker.compose.project':'wasalx-simulation-unit','com.docker.compose.service':'zammad-railsserver'}}};
 const session={portalOrigin:origin,runId:'unit',checkpoint:async()=>{},model:{name:'wasalx-simulation-unit'},tenantId:'00000000-0000-4000-8000-000000000001',containers:{'zammad-railsserver':container},run:async(command,args)=>{assert.equal(command,'docker');if(args[0]==='inspect')return JSON.stringify([container]);assert.equal(args[0],'exec');const payload=JSON.parse(Buffer.from(args.find(value=>value.startsWith('WASALX_FIXTURE_READ_INPUT=')).split('=')[1],'base64url'));return JSON.stringify({readback:payload.kind==='states'?[{id:2,name:'open'},{id:4,name:'closed'}]:{id:52,number:'77001',state_id:page.stateId,title:'Owned ticket'}});}};
 return{page,session,verify:async()=>binding()};
}

test('ticket UPDATE binds the opened record, original intent, exact APPLIED receipt and actual saved notice',async()=>{
 const page=new TicketPage(),operator=ticketOperator(page),before=[];
 const result=await updatePortalTicketState(operator,{ticketId:'52',ticketNumber:'77001',stateId:4,checkpoint:async()=>{},beforeDispatch:async intent=>{assert.equal(page.writes.length,0);before.push(intent);}});
 assert.equal(result.value.state,'APPLIED');assert.equal(result.value.operation_id,result.intent.operation_id);assert.equal(result.value.ticket_id,'52');assert.deepEqual(before,[result.intent]);assert.equal(page.writes.length,1);assert.equal(page.savedNotices,1);assert.equal(page.unrouted,1);
});

test('ticket UPDATE rejects a different rendered record or intent before the original write can continue',async()=>{
 const opened=new TicketPage({openedTicketId:'53'});await assert.rejects(()=>updatePortalTicketState(ticketOperator(opened),{ticketId:'52',ticketNumber:'77001',stateId:4,checkpoint:async()=>{}}),/Opened ticket differs/);assert.equal(opened.writes.length,0);
 const wrongIntent=new TicketPage({intentTicketId:'53'});await assert.rejects(()=>updatePortalTicketState(ticketOperator(wrongIntent),{ticketId:'52',ticketNumber:'77001',stateId:4,checkpoint:async()=>{}}),error=>error.intent?.ticket_id==='53'&&error.message.includes('another ticket'));assert.equal(wrongIntent.writes.length,0);assert.equal(wrongIntent.aborted,1);assert.equal(wrongIntent.unrouted,1);
});

for(const scenario of['unknown','operation','ticket','missing-operation','missing-ticket','lost'])test(`ticket filter preserves uncertainty and skips restoration for ${scenario} receipt despite changed native state`,async()=>{
 const receipt=intent=>({state:scenario==='unknown'?'UNKNOWN':'APPLIED',...(scenario==='missing-operation'?{}:{operation_id:scenario==='operation'?'00000000-0000-4000-8000-999999999999':intent.operation_id}),...(scenario==='missing-ticket'?{}:{ticket_id:scenario==='ticket'?'53':intent.ticket_id})}),page=new TicketPage({receipt,lost:scenario==='lost'}),operator=ticketOperator(page);let uncertain=false,settled=0;
 await assert.rejects(()=>filterPortalGroupTicket({operator,groupId:'00000000-0000-4000-8000-000000000002',ticketId:'52',ticketNumber:'77001',checkpoint:async()=>{},providerRead:async()=>[],beforeProvider:[],markUncertain:()=>{uncertain=true;},markSettled:()=>{uncertain=false;settled++;}}),error=>Boolean(error.intent?.operation_id));
 assert.equal(page.stateId,4,'The backend changed even though the acknowledgement is unsafe');assert.equal(page.writes.length,1,'An ambiguous close cannot be replayed or restored');assert.equal(uncertain,true);assert.equal(settled,0);assert.equal(page.unrouted,1);
});

test('ticket filter restores its owned closed state only after exact receipts and native corroboration',async()=>{
 const page=new TicketPage(),operator=ticketOperator(page),lifecycle=[];
 const result=await filterPortalGroupTicket({operator,groupId:'00000000-0000-4000-8000-000000000002',ticketId:'52',ticketNumber:'77001',checkpoint:async()=>{},providerRead:async()=>[],beforeProvider:[],markUncertain:()=>lifecycle.push('uncertain'),markSettled:()=>lifecycle.push('settled')});
 assert.equal(result.result,'passed');assert.deepEqual(page.writes.map(row=>row.state_id),['4','2']);assert.deepEqual(lifecycle,['uncertain','settled','uncertain','settled']);assert.equal(page.stateId,2);assert.equal(page.savedNotices,2);
});

for(const failure of['drift','unavailable'])test(`ticket filter retains its exact acknowledged close when native corroboration is ${failure}`,async()=>{
 const page=new TicketPage(),operator=ticketOperator(page),originalRun=operator.session.run;let uncertain=false,settled=0;
 operator.session.run=async(command,args)=>{if(args[0]==='exec'&&page.writes.length){if(failure==='unavailable')throw Error('Native corroboration unavailable');return JSON.stringify({readback:{id:52,number:'77001',state_id:2,title:'Owned ticket'}});}return originalRun(command,args);};
 await assert.rejects(()=>filterPortalGroupTicket({operator,groupId:'00000000-0000-4000-8000-000000000002',ticketId:'52',ticketNumber:'77001',checkpoint:async()=>{},providerRead:async()=>[],beforeProvider:[],markUncertain:()=>{uncertain=true;},markSettled:()=>{uncertain=false;settled++;}}));
 assert.equal(page.stateId,4);assert.equal(page.writes.length,1);assert.equal(uncertain,true);assert.equal(settled,0);assert.equal(page.savedNotices,1);
});

test('portal successors preserve every historical leaf without inheriting executions or native contexts',()=>{
 const pairs=[[definitions.map(row=>row.id),portalGroupDefinitions.map(row=>row.id)],[completeNativeBusinessTestIds,completePortalBusinessTestIds],[nativeGrantTestIds,portalGrantTestIds],[nativeGrantQualityIds,portalGrantQualityIds],[nativeHistoryIds,portalHistoryIds],[nativePrivacyIds,portalPrivacyIds]];
 for(const[before,after]of pairs)assert.deepEqual([...after].sort(),before.map(id=>id+'::portal').sort());
 assert.equal(Object.keys(portalGroupSuccessors).length,82);assert.equal(new Set(Object.values(portalGroupSuccessors)).size,82);assert(portalGroupDefinitions.every(row=>!Object.hasOwn(row,'executions')));
 assert.deepEqual(Object.keys(portalGroupContextRequirements).sort(),Object.values(portalGroupSuccessors).sort());assert.equal(Object.values(portalGroupContextRequirements).reduce((total,contexts)=>total+contexts.length,0),174);assert(portalGroupDefinitions.every(row=>row.requiredContextIds.every(id=>id.startsWith('agent-en-'))));
 for(const id of portalGrantQualityIds)assert.equal(portalGroupContextRequirements[id].length,id.startsWith('team-access/')?3:1);
 assert.deepEqual(portalGroupContexts().map(row=>[row.contextId,row.viewport,row.surface]),[['agent-en-desktop',{width:1440,height:1000},'portal'],['agent-en-tablet',{width:820,height:1180},'portal'],['agent-en-mobile',{width:390,height:844},'portal']]);
});

test('portal operation observer admits one UI request and preserves the exact original intent',async()=>{
 const page=new ActionPage(),rows=[],dispatched=[];const result=await observePortalAction({operator:{page},operation:'GROUP_SEND',action:()=>page.dispatch(),checkpoint:async row=>rows.push(row),beforeDispatch:value=>dispatched.push(value)});
 assert.deepEqual(result,{value:{accepted:true},intent:input,status:200});assert.deepEqual(dispatched,[input]);assert.equal(page.continued.length,1);assert.equal(page.unrouted,1);assert.equal(page.listenerCount('response'),0);assert.deepEqual(rows.map(row=>row.phase),['intent','receipt']);assert(!rows.some(row=>JSON.stringify(row).includes('csrf')));
});

test('duplicate UI writes are blocked and an unknown dispatched result retains the intent',async()=>{
 const duplicate=new ActionPage();await assert.rejects(()=>observePortalAction({operator:{page:duplicate},operation:'GROUP_SEND',checkpoint:async()=>{},action:()=>Promise.all([duplicate.dispatch(),duplicate.dispatch()])}),/Duplicate/);assert.equal(duplicate.continued.length,1);assert.equal(duplicate.aborted,1);assert.equal(duplicate.unrouted,1);
 const unknown=new ActionPage();await assert.rejects(()=>observePortalAction({operator:{page:unknown},operation:'GROUP_SEND',checkpoint:async()=>{},action:async()=>{await unknown.dispatch();throw Error('Browser interrupted after dispatch');}}),error=>error.intent===input&&error.message.includes('interrupted'));assert.equal(unknown.continued.length,1);assert.equal(unknown.unrouted,1);assert.equal(unknown.listenerCount('response'),0);
});

test('durable asynchronous intent registration completes before the original request continues',async()=>{
 const page=new ActionPage();let release,seen;const held=new Promise(resolve=>{release=resolve;}),registered=new Promise(resolve=>{seen=resolve;});
 const pending=observePortalAction({operator:{page},operation:'GROUP_SEND',checkpoint:async()=>{},beforeDispatch:async()=>{seen();await held;},action:()=>page.dispatch()});await registered;assert.equal(page.continued.length,0);release();await pending;assert.equal(page.continued.length,1);
});

test('non-success UI response exposes only safe status and never retries or cancels',async()=>{
 const page=new ActionPage({status:503});await assert.rejects(()=>observePortalAction({operator:{page},operation:'GROUP_SEND',checkpoint:async()=>{},action:()=>page.dispatch()}),error=>error.status===503&&error.intent===input);assert.equal(page.continued.length,1);assert.equal(page.unrouted,1);
});

test('catalog injection targets only same-origin GROUP_LIST and preserves its normalized envelope',async()=>{
 let seen=0,fallback=0,body;const handler=portalGroupCatalogBoundary({origin,mode:'empty',onSeen:()=>seen++});
 await handler({request:()=>request('GROUP_LIST',{}),fulfill:async response=>{body=JSON.parse(response.body);}});assert.deepEqual(body,{items:[],next_cursor:null});
 for(const req of[request('GROUP_SEND'),request('GROUP_LIST',{},'https://other.example/api/inbox'),{method:()=> 'GET',url:()=>origin+'/api/inbox',postDataJSON:()=>null}])await handler({request:()=>req,fallback:async()=>fallback++});assert.equal(seen,1);assert.equal(fallback,3);assert.equal(groupOperation({method:()=> 'POST',url:()=>origin+'/api/inbox',postDataJSON:()=>{throw Error('not JSON');}}),null);
});

function binding(viewport={width:1440,height:1000}){return{contractVersion:2,surface:'portal',role:'agent',locale:'en',actorRef:'sha256:'+'a'.repeat(64),tenantRef:'sha256:'+'b'.repeat(64),viewport,verifiedAt:new Date().toISOString(),nativeUserId:'42',projectionRevision:1};}
test('result binding uses the actual portal viewport and fails on unsupported or forged contexts',async()=>{
 const operator={verify:async()=>binding({width:390,height:844})},row=await portalGroupResult(operator,{testId:'old-leaf',result:'passed',proof:{exactSource:true}});assert.equal(row.testId,'old-leaf::portal');assert.equal(row.supersedesTestId,'old-leaf');assert.equal(row.contextId,'agent-en-mobile');assert.equal(row.verifiedContext.surface,'portal');
 await assert.rejects(()=>portalGroupResult({verify:async()=>binding({width:800,height:600})},{testId:'old-leaf',result:'passed',proof:{}}));
 await assert.rejects(()=>portalGroupResult({verify:async()=>({...binding(),surface:'native'})},{testId:'old-leaf',result:'passed',proof:{}}));
});

test('business and lifecycle reject stale barriers or historical adoption before runtime work',async()=>{
 const session={tenantId:'tenant',model:{name:'wasalx-simulation-current'},actorBinding:{userMatched:true,workspaceMatched:true}},group={namespace:'current',tenantId:'tenant',evidenceMode:'simulated',connectionId:'connection',zammadGroupId:'2'};
 await assert.rejects(()=>portalBusinessStage(session,{namespace:'current',inputs:{group,directConnection:{connectionId:'connection'},portalTeamAccess:{namespace:'old',tenantId:'tenant',nativeGroupId:'2'}},config:{}}));
 await assert.rejects(()=>portalLifecycleStage({operatorSurface:'portal'},{config:{retainedQ094:{namespace:'old'}}}),/Historical/);
});

test('current GOWS receipt join selects the explicit portal UI source and never adopts historical rows',async()=>{
 const id=groupTextReceiptTestId+'::portal',finishedAt='2026-10-18T00:00:01Z',inputs={group:{namespace:'n',tenantId:'t',connectionId:'c'},nativeBusiness:{namespace:'n',surface:'portal',results:[{testId:id,result:'failed',finishedAt}]},directFlow:{fixtures:{tenantId:'t',connectionId:'c'},finishedAt,outputProofs:[{outbox:[{state:'SENT',external_message_id:'true_123@c.us_direct',external_chat_id:'123@c.us'}],added:[{id:'true_123@c.us_direct',textSha256:'hash'}],expectedHash:'hash'}]}};
 // Passed direct rows are re-observed read-only in the owner portal; the blocked group row is never visited.
 const visits=[],stableReads=[],ownerChecks=[];let url='https://portal.test/app',viewport={width:1024,height:768},listener;
 const waitFor=async()=>{},heading={waitFor},current={getByRole:()=>heading,locator:selector=>{assert.equal(selector,'.status');return{innerText:async()=>'Sent'};}};
 const dialog={waitFor,locator:selector=>{assert.equal(selector,'.connection-detail-section');return{filter:({has})=>{assert.equal(has,heading);return current;}};}};
 const ownerPage={on:(event,f)=>{assert.equal(event,'response');listener=f;},off:(event,f)=>{assert.equal(f,listener);listener=undefined;},setViewportSize:async value=>{viewport=value;},viewportSize:()=>viewport,evaluate:async()=>'en',url:()=>url,
  goto:async value=>{url=value;visits.push(value);listener?.({url:()=>url.replace('/app?view=deliveries&delivery=','/api/deliveries/'),request:()=>({method:()=>'GET'}),status:()=>200});},
  getByRole:(role,options)=>{if(role==='heading'){assert.deepEqual(options,{name:'Current delivery state',exact:true});return heading;}assert.deepEqual([role,options],['dialog',{name:'Delivery timeline',exact:true}]);return dialog;}};
 const session={tenantId:'t',ownerId:'owner',portalOrigin:'https://portal.test',ownerPage,actorBinding:{userMatched:true,workspaceMatched:true},checkpoint:async()=>{},
  verifyOwner:async(page,actorId,role,tenantId)=>{assert.equal(page,ownerPage);ownerChecks.push([actorId,role,tenantId]);return{userMatched:true,workspaceMatched:true};},
  scoped:async(sql,args)=>{assert.match(sql,/FROM delivery_outbox WHERE tenant_id=\$1 AND id=ANY/);stableReads.push(args);return[{id:args[1][0],state:'SENT'}];},
  directCallbacks:{providerRead:async()=>({receipts:['retained']})}};
 inputs.directFlow.outputProofs[0].outbox[0].id='direct-delivery';
 const result=await portalGowsReceiptStage(session,{namespace:'n',inputs});assert.equal(result.results[0].proof.blockedByTestId,id);assert.equal(result.results[0].result,'blocked');
 const direct=result.results[1];assert.equal(direct.result,'passed');assert.equal(direct.contextId,'tenant_owner-en-desktop');assert.equal(direct.proof.ownerUi.visible,true);assert.equal(direct.proof.ownerUi.detailStatus,200);assert.equal(direct.proof.noProviderReplay,true);assert.equal(direct.verifiedContext.role,'tenant_owner');
 assert.deepEqual(visits,['https://portal.test/app?view=deliveries&delivery=direct-delivery']);assert.deepEqual(stableReads,[['t',['direct-delivery']],['t',['direct-delivery']]]);assert.deepEqual(ownerChecks,[[undefined,undefined,undefined],['owner','tenant_owner','t']]);assert.deepEqual(viewport,{width:1024,height:768});
 inputs.nativeBusiness.results[0].testId=groupTextReceiptTestId;await assert.rejects(()=>portalGowsReceiptStage(session,{namespace:'n',inputs}));inputs.nativeBusiness.results[0].testId=id;inputs.nativeBusiness.surface='native';await assert.rejects(()=>portalGowsReceiptStage(session,{namespace:'n',inputs}));
});

test('team grant readback finds the exact later-page member both before and after a save',async()=>{
 let saved=false;const calls=[],read=async(operation,input)=>{calls.push({operation,input});assert.equal(operation,'TEAM_SHOW');assert.equal(input.team_id,'7');return input.members_after?{id:'7',members:[{id:'exact-member',direct_access:saved?['full']:[]}],members_next_cursor:null}:{id:'7',members:[{id:'unrelated',direct_access:['read']}],members_next_cursor:'after-first'};};
 const before=await findPortalTeamMember(read,{teamId:'7',memberId:'exact-member'});assert.deepEqual(before.member.direct_access,[]);saved=true;const after=await findPortalTeamMember(read,{teamId:'7',memberId:'exact-member'});assert.deepEqual(after.member.direct_access,['full']);assert.deepEqual(calls.map(row=>row.input),[{team_id:'7'},{team_id:'7',members_after:'after-first'},{team_id:'7'},{team_id:'7',members_after:'after-first'}]);
});

test('team grant member traversal rejects foreign targets and repeated cursors',async()=>{
 await assert.rejects(()=>findPortalTeamMember(async()=>({id:'8',members:[],members_next_cursor:null}),{teamId:'7',memberId:'member'}),/changed its target/);
 let reads=0;await assert.rejects(()=>findPortalTeamMember(async()=>{reads++;return{id:'7',members:[],members_next_cursor:'same'};},{teamId:'7',memberId:'member'}),/Repeated/);assert.equal(reads,2);
});

test('actual browser upload File observer supports portal files and preserves the native default',async()=>{
 const page={evaluate:(fn,input)=>fn(input)};
 for(const field of['files','File']){const original=FormData.prototype.append,observer=await observeUploadFile(page,field);try{const data=new FormData();data.append(field,new Blob([Uint8Array.from([2,4,6])],{type:'audio/webm'}),'voice.webm');assert.deepEqual(await observer.read(),Buffer.from([2,4,6]));}finally{await observer.close();}assert.equal(FormData.prototype.append,original);assert.equal(globalThis.__wasalxMediaFileObserver,undefined);}
 await assert.rejects(()=>observeUploadFile(page,'unreviewed'));
});

for(const failure of[false,true])test(`portal unread proof waits for original read settlement, continuation failure=${failure}`,async()=>{
 let handler,resolveResponse,continued=0,unrouted=0,finished=0;const req=request('GROUP_READ',{group_id:'g',message_id:'m'}),response={request:()=>req,ok:()=>true,status:()=>200,finished:async()=>{finished++;return null;}};
 const page={waitForResponse:()=>new Promise(resolve=>{resolveResponse=resolve;}),route:async(_,fn)=>{handler=fn;},unroute:async()=>{unrouted++;},goto:async()=>handler({request:()=>req,continue:async()=>{continued++;resolveResponse(response);if(failure)throw Error('Original continue failed');},abort:async()=>{}}),locator:()=>({getByText:()=>({waitFor:async()=>{}})}),viewportSize:()=>({width:1440,height:1000})};
 const run=()=>observePortalUnreadWithHeldRead({page,url:origin+'/app',groupId:'g',messageId:'m',count:1,checkpoint:async()=>{}});if(failure)await assert.rejects(run,/Original continue failed/);else assert.equal((await run()).responseCompleted,true);assert.equal(continued,1);assert.equal(unrouted,1);assert.equal(finished,1);
});

for(const hang of['handler','body','primary'])test(`portal unread settlement is bounded for ${hang}`,async()=>{
 let handler,resolveResponse,released=false,unrouted=false;const never=new Promise(()=>{}),req=request('GROUP_READ',{group_id:'g',message_id:'m'}),response={request:()=>req,ok:()=>true,status:()=>200,finished:()=>hang!=='handler'?never:Promise.resolve(null)};
 const page={waitForResponse:()=>new Promise(resolve=>{resolveResponse=resolve;}),route:async(_,fn)=>{handler=fn;},unroute:async()=>{unrouted=true;},goto:async()=>handler({request:()=>req,continue:async()=>{released=true;resolveResponse(response);if(hang==='handler')await never;},abort:async()=>{}}),locator:()=>({getByText:()=>({waitFor:async()=>{}})}),viewportSize:()=>({width:1440,height:1000})};
 await assert.rejects(()=>observePortalUnreadWithHeldRead({page,url:origin+'/app',groupId:'g',messageId:'m',count:1,settlementTimeoutMs:10,checkpoint:async()=>{if(hang==='primary')throw Error('Visible proof failed');}}),hang==='primary'?/Visible proof failed/:/settlement deadline/);assert(released&&unrouted);
});

test('binary denial probe uses the read-only portal endpoint and keeps CSRF in browser memory',async()=>{
 const calls=[],csrf='private-synthetic-csrf',prefix='((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]}).rsc.push(';
 const scripts=[{textContent:prefix+JSON.stringify(JSON.stringify({csrfToken:csrf}))+')'}];
 const page={evaluate:(fn,input)=>runInNewContext(`(${fn.toString()})(input)`,{input,location:{origin},DOMParser:class{parseFromString(){return{scripts};}},TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,URL,AbortSignal,crypto:webcrypto,fetch:async(path,options)=>{calls.push(path);if(path==='/app')return{ok:true,url:origin+'/app',text:async()=>''};assert.equal(path,'/api/inbox/group-media');assert.equal(options.headers['x-wasalx-csrf'],csrf);assert.deepEqual(JSON.parse(options.body),{group_id:'g',message_id:'m'});return{status:403,arrayBuffer:async()=>new TextEncoder().encode('Denied').buffer};}})};
 const result=await probePortalGroupMedia({verify:async()=>binding(),page,session:{portalOrigin:origin}},{groupId:'g',messageId:'m'});assert.equal(result.status,403);assert.equal(result.bytes,6);assert.match(result.sha256,/^[a-f0-9]{64}$/u);assert(!JSON.stringify(result).includes(csrf));assert.deepEqual(calls,['/app','/api/inbox/group-media']);
});

test('current stage source selects portal controls and retains private corroboration without native browser ingress',()=>{
 for(const name of['simulation-portal-group-stage','simulation-portal-business-stage','simulation-portal-group-observers','simulation-portal-group-ticket','simulation-portal-group-identity','simulation-portal-group-history','simulation-portal-group-media','simulation-portal-group-cross-connection']){
  const source=readFileSync(new URL(`../scripts/release/${name}.mjs`,import.meta.url),'utf8');assert(!source.includes('/api/v1/'));assert(!source.includes('/desktop/'));assert(!source.includes('/mobile/'));assert(!source.includes('ensureNativeAgent('));
 }
 const ticket=readFileSync(new URL('../scripts/release/simulation-portal-group-ticket.mjs',import.meta.url),'utf8');assert(ticket.includes("operation:'GROUP_CREATE_TICKET'"));assert(ticket.includes('reconcileNativeTicketOutcome'));assert(ticket.includes('privateNativeRead'));assert(ticket.includes("name:'Show source message'"));
 const inventory=readFileSync(new URL('../scripts/test-unit.mjs',import.meta.url),'utf8');assert.equal(inventory.split('"tests/simulation-portal-groups.test.mjs"').length-1,1);
});
