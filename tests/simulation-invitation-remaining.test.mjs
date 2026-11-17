import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{admitInvitationRemaining,navigateInvitationStart,restoreInvitationActor,verifyInvitationAgentAssertion,invitationRejectDiagnostic,invitationRouteReady,invitationFormCategory,invitationFailureFormCategory}from'../scripts/release/simulation-invitation-remaining-stage.mjs';import{definitions}from'../scripts/release/simulation-invitation-remaining-definitions.mjs';
test('invitation agent evidence verifies current actor in the same cookie context',async()=>{const context={},assertionPage={context:()=>context,viewportSize:()=>({width:1440,height:1000}),evaluate:async()=> 'en'},verificationPage={size:{width:1280,height:720},context:()=>context,viewportSize(){return this.size},setViewportSize:async function(size){this.size={...size}},evaluate:async()=> 'en'},actor={subject:'oidc-subject'},receipt={userId:'user-id'},session={tenantId:'tenant-id',verifyOwner:async(page,id,role,tenantId)=>{assert.equal(page,verificationPage);assert.deepEqual([id,role,tenantId],['user-id','agent','tenant-id']);return{userMatched:true,workspaceMatched:true}}};const binding=await verifyInvitationAgentAssertion(session,actor,assertionPage,verificationPage,receipt);assert.deepEqual(binding.viewport,{width:1440,height:1000});assert.match(binding.actorRef,/^sha256:/);assert.match(binding.tenantRef,/^sha256:/);await assert.rejects(verifyInvitationAgentAssertion({...session,verifyOwner:async()=>({userMatched:false,workspaceMatched:true})},actor,assertionPage,verificationPage,receipt));await assert.rejects(verifyInvitationAgentAssertion(session,actor,assertionPage,{...verificationPage,context:()=>({})},receipt),/share the asserting browser context/);});
test('invitation verification page cleanup preserves the primary failure and restores the actor',async()=>{
 const source=readFileSync(new URL('../scripts/release/simulation-invitation-remaining-stage.mjs',import.meta.url),'utf8'),start=source.lastIndexOf('}catch(e){primaryError=e;}finally{'),end=source.lastIndexOf('if(primaryError)throw primaryError;');assert(start>=0&&end>start);
 const cleanup=new (Object.getPrototypeOf(async function(){}).constructor)('initial','page','s','actor','a','listeners','hash','restoreInvitationActor','let verificationPage=page,primaryError;try{if(initial)throw initial;'+source.slice(start,end)+'if(primaryError)throw primaryError;');
 const primary=Error('verification failed'),close=Error('close failed'),restore=Error('restore failed');
 for(const initial of [primary,null]){let restored=0;await assert.rejects(cleanup(initial,{close:async()=>{throw close},off:()=>{}},{tenantId:'t',checkpoint:async()=>{}},{},{},{},()=> 'safe',async()=>{restored++;throw restore}),error=>error===(initial??close));assert.equal(restored,1);}
});
const a={evidenceMode:'simulated',namespace:'now',tenantId:'t',invitationId:'i',userId:'u',memberId:'m'},s={tenantId:'t',capabilities:{secondActor:{userId:'u'}}};
test('invitation9 requires current intended second actor receipt',()=>{assert.equal(definitions.length,9);assert.equal(admitInvitationRemaining(s,{namespace:'now',inputs:{secondActor:a}}),a);assert.throws(()=>admitInvitationRemaining(s,{namespace:'old',inputs:{secondActor:a}}));assert.throws(()=>admitInvitationRemaining({...s,capabilities:{secondActor:{userId:'other'}}},{namespace:'now',inputs:{secondActor:a}}));});
test('existing sent intent is read not resent and expired row cleanup is fenced',()=>{const x=readFileSync(new URL('../scripts/release/simulation-invitation-remaining-stage.mjs',import.meta.url),'utf8');assert(x.includes("assert.equal(sent[0].state,'SENT')"));assert(x.includes('assert.equal(matches.length,1)'));assert(!x.includes("'/api/team/invitations'"));assert(x.includes("flag:'wx',mode:0o600"));assert(x.includes('AND token_hash=$2'));assert(x.includes('NOT EXISTS(SELECT 1 FROM tenant_invitation_email_outbox'));assert(x.includes('clearTimeout(timer)'));assert(x.includes("actor.login(page,a.role,'/invitations/result')"));});

test('actor restoration verifies exact identity and role after app return',async()=>{let verified=false,checkpointed=false;const page={goto:async u=>assert.equal(u,'http://portal/app'),waitForFunction:async()=>{},url:()=> 'http://portal/app'};await restoreInvitationActor({portalOrigin:'http://portal',keycloakOrigin:'http://id',tenantId:'t',verifyOwner:async(p,id,role)=>{assert.equal(p,page);assert.equal(id,'u');assert.equal(role,'agent');verified=true},checkpoint:async r=>{assert(verified);assert.equal(r.tenantId,'t');checkpointed=true}},{page},{userId:'u',role:'agent'});assert(checkpointed);await assert.rejects(restoreInvitationActor({portalOrigin:'http://portal',verifyOwner:async()=>{throw Error('wrong tenant')},checkpoint:async()=>assert.fail('must not claim restored')},{page},{userId:'u',role:'agent'}),/wrong tenant/);});
test('expired cleanup binds tenant and email and preserves unexpected rows',()=>{const x=readFileSync(new URL('../scripts/release/simulation-invitation-remaining-stage.mjs',import.meta.url),'utf8');assert(x.includes('AND tenant_id=$3 AND email=$4'));assert(x.includes('[expiredId,tokenHash,s.tenantId,config.email]'));assert(x.includes("state IN('PENDING','EXPIRED')"));assert(x.includes('await restoreInvitationActor(s,actor,a)'));});
test('invitation navigation reloads the same URL and observes the exact start',async()=>{let current='http://portal/invitations/accept#token=x',reloads=0,navigations=0,listener;const page={url:()=>current,on:(event,fn)=>{assert.equal(event,'request');listener=fn},off:(event,fn)=>{assert.equal(event,'request');assert.equal(fn,listener);listener=undefined}},request={url:()=> 'http://portal/api/invitations/accept/start',method:()=> 'POST',postDataJSON:()=>({token:'x'})},o={reload:async()=>{reloads++;queueMicrotask(()=>listener(request))},navigate:async url=>{navigations++;current=url;queueMicrotask(()=>listener(request))}};await navigateInvitationStart(page,'http://portal',current,'x',o,50);assert.equal(reloads,1);assert.equal(navigations,0);current='http://portal/elsewhere';await navigateInvitationStart(page,'http://portal','http://portal/invitations/accept#token=x','x',o,50);assert.equal(navigations,1);assert.equal(listener,undefined);});

const cleanupSource=readFileSync(new URL('../scripts/release/simulation-invitation-remaining-stage.mjs',import.meta.url),'utf8'),start=cleanupSource.indexOf('let fixtureError,fixtureRestored=false;'),end=cleanupSource.indexOf('if(fixtureError)throw fixtureError;',start)+'if(fixtureError)throw fixtureError;'.length;assert(start>=0);const cleanupFlow=new (Object.getPrototypeOf(async function(){}).constructor)('s','write','client','check','reject','expiredId','tokenHash','config','namespace','hash','expiredToken',cleanupSource.slice(start,end));
for(const failInsert of[true,false])test('actual expired fixture flow preserves '+(failInsert?'primary failure':'cleanup-only failure'),async()=>{const primary=Error('original fixture failure'),cleanup=Error('restore failure');let closed=0;const records=[];const write=async sql=>{if(sql.startsWith('INSERT')&&failInsert)throw primary;if(sql.startsWith('DELETE'))throw cleanup;};await assert.rejects(()=>cleanupFlow({checkpoint:async r=>records.push(r),scoped:async()=>[],tenantId:'t',ownerId:'u',portalOrigin:'http://portal'},write,{end:async()=>{closed++}},async()=>{},async()=>{},'id','hash',{email:'synthetic@example.invalid'},'n',()=> 'safehash','private'),e=>e===(failInsert?primary:cleanup));assert.equal(closed,1);assert(records.some(x=>x.phase==='expired-invitation-fixture-restoration-failed'));assert(!records.some(x=>x.phase==='expired-invitation-fixture-restored'));});


test('rejection diagnostic exposes only allowlisted phase and route category on timeout',()=>{
 const error=Object.assign(new Error('PRIVATE_TOKEN_and_URL'),{name:'TimeoutError'}),portal='http://portal.invalid',identity='http://identity.invalid';
 for(const [url,originCategory,routeCategory] of [
  [portal+'/invitations/accept?email=PRIVATE#token=PRIVATE','portal','accept'],
  [portal+'/invitations/result?token=PRIVATE','portal','result'],
  [identity+'/realms/wasalx/protocol/openid-connect/auth?code=PRIVATE','identity','tenant-realm'],
  ['http://foreign.invalid/private/PRIVATE','other','other'],
  ['not a url PRIVATE','unparseable','unparseable']]){
  const diagnostic=invitationRejectDiagnostic('route-readiness',{url:()=>url},portal,identity,error);
  assert.equal(diagnostic.phase,'route-readiness');assert.equal(diagnostic.originCategory,originCategory);assert.equal(diagnostic.routeCategory,routeCategory);assert.equal(diagnostic.errorClass,'TimeoutError');assert.match(diagnostic.messageSha256,/^[a-f0-9]{64}$/);assert(!JSON.stringify(diagnostic).includes('PRIVATE'));assert(!JSON.stringify(diagnostic).includes('portal.invalid'));assert(!JSON.stringify(diagnostic).includes('identity.invalid'));
 }
 assert.throws(()=>invitationRejectDiagnostic('raw-url',{url:()=>portal},portal,identity,error));
 const unavailable=invitationRejectDiagnostic('terminal-heading',{url:()=>{throw error;}},portal,identity,error);assert.equal(unavailable.routeCategory,'unparseable');
});

test('invitation readiness accepts only visible supported identity inputs or exact portal terminal',async()=>{
 const portal='http://portal.invalid',keycloak='http://identity.invalid',terminal='/invitations/result';
 const field=(visible)=>({getClientRects:()=>visible?[{}]:[]});
 const env=(origin,pathname,fields)=>({location:{origin,pathname},document:{querySelectorAll:selector=>fields[selector]??[]}});
 const args={portal,keycloak,terminal},identity='/realms/wasalx/protocol/openid-connect/auth';
 const username='input[name=username]',password='input[name=password][type=password]',otp='input[name=otp]';
 assert(invitationRouteReady(args,env(keycloak,identity,{[password]:[field(true)]})));
 assert(invitationRouteReady(args,env(keycloak,identity,{[username]:[field(false)],[password]:[field(true)]})));
 assert(invitationRouteReady(args,env(keycloak,identity,{[username]:[field(true)]})));
 assert(invitationRouteReady(args,env(keycloak,identity,{[otp]:[field(true)]})));
 assert.equal(invitationRouteReady(args,env(keycloak,identity,{[username]:[field(false)]})),false);
 assert.equal(invitationRouteReady(args,env(keycloak,identity,{})),false);
 assert.equal(invitationRouteReady(args,env('http://foreign.invalid',terminal,{[password]:[field(true)]})),false);
 assert(invitationRouteReady(args,env(portal,terminal,{})));
 assert.equal(invitationRouteReady(args,env(portal,'/invitations/accept',{[password]:[field(true)]})),false);
 assert.equal(invitationFormCategory(env(keycloak,identity,{[username]:[field(false)],[password]:[field(true)]})),'password-only');
 assert.equal(invitationFormCategory(env(keycloak,identity,{[username]:[field(true)],[password]:[field(true)]})),'username-password');
 assert.equal(invitationFormCategory(env(keycloak,identity,{})),'no-supported-form');
 const safe=await invitationFailureFormCategory({evaluate:async fn=>fn(env(keycloak,identity,{[password]:[field(true)]}))});assert.equal(safe,'password-only');
 assert.equal(await invitationFailureFormCategory({evaluate:async()=>{throw Error('PRIVATE_TOKEN');}}),'unavailable');
});
import{admitAnonymousInvitationContexts,observeAnonymousInvitationRemaining,anonymousInvitationSuffixes}from'../scripts/release/simulation-invitation-remaining-stage.mjs';
test('anonymous invitation contexts must be explicitly allocated, unique and anonymous',()=>{
 const desktop={contextId:'anonymous-en-desktop',viewport:{width:1440,height:1000}};assert.deepEqual(admitAnonymousInvitationContexts([desktop]),[desktop]);assert.equal(anonymousInvitationSuffixes.length,7);
 for(const contexts of [undefined,[],[desktop,desktop],[{...desktop,contextId:'agent-en-desktop'}],[{...desktop,contextId:'anonymous-ar-desktop'}],[{contextId:'anonymous-en-tablet'}],[{...desktop,viewport:{width:0,height:1000}}]])assert.throws(()=>admitAnonymousInvitationContexts(contexts));
});
test('anonymous observer refuses a context that already carries a portal or platform session and closes it',async()=>{
 for(const name of ['__Host-wasalx_session','wasalx_platform_session']){let closed=0,pages=0;const browser={newContext:async options=>{assert.deepEqual(options,{viewport:{width:1440,height:1000},locale:'en-US'});return{cookies:async()=>[{name}],newPage:async()=>{pages++;},close:async()=>{closed++;}};}};
  await assert.rejects(observeAnonymousInvitationRemaining({browser,portalOrigin:'http://portal.invalid',keycloakOrigin:'http://identity.invalid',acceptedUrl:'http://portal.invalid/invitations/accept#token=t',snapshot:async()=>({}),before:{},checkpoint:async()=>assert.fail('No row without an anonymous context'),contexts:[{contextId:'anonymous-en-desktop',viewport:{width:1440,height:1000}}]}),/started with a session/);assert.equal(closed,1);assert.equal(pages,0);}
 await assert.rejects(observeAnonymousInvitationRemaining({browser:{newContext:async()=>assert.fail('No unallocated context')},contexts:[]}),/explicitly allocated/);
});
test('anonymous observer opens each allocated context at its published viewport, never a desktop default',async()=>{
 const {remoteViewports}=await import("../scripts/release/journey-context-contract.mjs"),mobile=remoteViewports.find(value=>value.name==='mobile'),opened=[];assert.deepEqual(mobile,{name:'mobile',width:390,height:844});
 const browser={newContext:async options=>{opened.push(options.viewport);return{cookies:async()=>[{name:'wasalx_session'}],newPage:async()=>assert.fail('Session context must stop first'),close:async()=>{}};}};
 await assert.rejects(observeAnonymousInvitationRemaining({browser,portalOrigin:'http://portal.invalid',keycloakOrigin:'http://identity.invalid',acceptedUrl:'http://portal.invalid/invitations/accept#token=t',snapshot:async()=>({}),before:{},checkpoint:async()=>{},contexts:[{contextId:'anonymous-en-mobile',viewport:{width:mobile.width,height:mobile.height}}]}),/started with a session/);
 assert.deepEqual(opened,[{width:390,height:844}]);
});
test('invitation stage observes anonymous contexts only from config allocation',()=>{const x=readFileSync(new URL('../scripts/release/simulation-invitation-remaining-stage.mjs',import.meta.url),'utf8');assert(x.includes('config.anonymousContexts===undefined?[]:admitAnonymousInvitationContexts(config.anonymousContexts)'));assert(x.includes('assert.equal(results.length,9+anonymousContexts.length*anonymousInvitationSuffixes.length)'));assert(!x.includes("['tablet',820,1180]"));});
