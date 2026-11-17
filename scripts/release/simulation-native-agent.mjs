import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {admitNativeMailUi} from './simulation-native-mail-browser.mjs';
export function assertNativeAgent(actor,expectedId){assert.equal(actor.id,expectedId);assert(Array.isArray(actor.roles)&&actor.roles.includes(2)&&!actor.roles.includes(1),'Native agent must not have admin role');assert(/^en(?:[-_]|$)/i.test(actor.locale));return actor;}
export function observeNativeLogin(page,{resourceTypes=null}={}){
 const consoleHashes=[],pageErrorHashes=[],requestFailureCodes=[],requestFailures=[];
 const onConsole=message=>{if(message.type()==='error'&&consoleHashes.length<10)consoleHashes.push(createHash('sha256').update(String(message.text())).digest('hex'));};
 const onPageError=error=>{if(pageErrorHashes.length<10)pageErrorHashes.push(createHash('sha256').update(String(error.message)).digest('hex'));};
 const onRequestFailed=request=>{if(resourceTypes&&!resourceTypes.includes(request.resourceType()))return;if(requestFailureCodes.length<10){const raw=request.failure()?.errorText??'',code=/^net::[A-Z0-9_]+$/u.test(raw)?raw:'other';requestFailureCodes.push(code);const url=new URL(request.url()),method=request.method(),resourceType=request.resourceType();requestFailures.push({recordedAt:new Date().toISOString(),code,method:/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/u.test(method)?method:'other',resourceType:/^[a-z]+$/u.test(resourceType)?resourceType:'other',pathSha256:createHash('sha256').update(url.pathname).digest('hex'),sameOrigin:url.origin===new URL(page.url()).origin});}};
 page.on('console',onConsole);page.on('pageerror',onPageError);page.on('requestfailed',onRequestFailed);
 return{stop(){page.off('console',onConsole);page.off('pageerror',onPageError);page.off('requestfailed',onRequestFailed);},async snapshot(phase){
  let path='unavailable';try{const pathname=new URL(page.url()).pathname;path=pathname==='/desktop/login'?pathname:/^\/desktop\/tickets\/[^/]+$/u.test(pathname)?'/desktop/tickets/:id':'other';}catch{/* No raw URL enters evidence. */}
  const state={phase,path,consoleHashes:[...consoleHashes],pageErrorHashes:[...pageErrorHashes],requestFailureCodes:[...requestFailureCodes],requestFailures:[...requestFailures]};
  let timer;try{const result=await Promise.race([(async()=>({readyState:await page.evaluate(()=>document.readyState),usernameCount:await page.getByRole('textbox',{name:'Username / Email',exact:true}).count(),usernameVisible:await page.getByRole('textbox',{name:'Username / Email',exact:true}).isVisible(),passwordCount:await page.getByRole('textbox',{name:'Password',exact:true}).count(),signInCount:await page.getByRole('button',{name:'Sign in',exact:true}).count(),navigationCount:await page.locator('[data-test-id="page-navigation"]').count()}))(),new Promise(resolve=>timer=setTimeout(()=>resolve({unavailable:true}),1500))]);Object.assign(state,result);}catch{state.unavailable=true;}finally{clearTimeout(timer);}return state;
 }};
}
export async function signInNativeAgentPage(page,email,password,expectedId,mark=()=>{}){
 mark('username-actionable');await page.getByRole('textbox',{name:'Username / Email',exact:true}).fill(email);
 mark('password-actionable');await page.getByRole('textbox',{name:'Password',exact:true}).fill(password);
 mark('sign-in-click');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 mark('navigation-ready');await page.locator('[data-test-id="page-navigation"]').waitFor({timeout:20000});
 mark('actor-readback');return verifyNativeAgentPage(page,expectedId);
}
export async function verifyNativeAgentPage(page,expectedId){
 const actor=await page.evaluate(async()=>{const r=await fetch('/api/v1/users/me',{cache:'no-store'});if(!r.ok)throw Error('Native actor unavailable');const u=await r.json();return{id:u.id,roles:u.role_ids,locale:document.documentElement.lang};});
 return assertNativeAgent(actor,expectedId);
}
export async function ensureNativeAgent(session){
 if(session.capabilities.nativeAgent){try{await session.capabilities.nativeAgent.verify();return session.capabilities.nativeAgent;}catch(error){error.qualificationOperation='native-agent-existing-verification';throw error;}}
 let operation='native-agent-lookup',ownedContext,loginObservation;
 try{
 const credentials=session.model.services['zammad-runtime-bootstrap'].environment;
 const email=credentials.WASALX_ZAMMAD_AGENT_EMAIL,password=credentials.WASALX_ZAMMAD_AGENT_PASSWORD;assert(email&&password);
 // Resolve this bootstrap fixture's current identity through the existing admin read session, never historical ID4.
 const expectedId=await session.nativePage.evaluate(findNativeAgent,email);assert(Number.isSafeInteger(expectedId)&&expectedId>0);
 operation='native-agent-navigation';
 const context=await session.browser.newContext();ownedContext=context;session.contexts.push(context);const page=await context.newPage();loginObservation=observeNativeLogin(page);page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(20000);
 await page.goto(session.nativeOrigin+'/desktop/login');
 operation='native-agent-sign-in';const actor=await signInNativeAgentPage(page,email,password,expectedId,step=>operation='native-agent-'+step);loginObservation.stop();loginObservation=null;
 const verify=()=>verifyNativeAgentPage(page,expectedId);
 operation='native-agent-ui-admission';await admitNativeMailUi(page);const capability={page,actorId:expectedId,verify};session.capabilities.nativeAgent=capability;operation='native-agent-capability-checkpoint';await session.checkpoint({phase:'native-agent-capability',actor,expectedId,ownedContext:true});return capability;
 }catch(error){
  if(loginObservation){const diagnostic=await loginObservation.snapshot(operation);loginObservation.stop();try{await session.checkpoint({...diagnostic,phase:'native-agent-login-diagnostic',diagnosticPhase:diagnostic.phase,errorClass:error.name,messageSha256:createHash('sha256').update(String(error.message)).digest('hex')});}catch{/* Preserve the original sign-in failure. */}}
  if(ownedContext){try{await ownedContext.close();const index=session.contexts.indexOf(ownedContext);if(index>=0)session.contexts.splice(index,1);}catch{/* Session cleanup still owns this context. */}}
  error.qualificationOperation=operation;throw error;
 }
}

export async function findNativeAgent(email,request=fetch){const r=await request('/api/v1/users/search?query='+encodeURIComponent(email)+'&limit=20',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Native agent fixture lookup unavailable');const rows=await r.json();if(!Array.isArray(rows))throw Error('Native user search shape invalid');if(rows.length>20)throw Error('Native user search exceeded bound');const ids=[...new Set(rows.map(u=>u.id))];if(ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('Native user search identity invalid');const users=await Promise.all(ids.map(async id=>{const response=await request('/api/v1/users/'+id,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Native user detail unavailable');const user=await response.json();if(user.id!==id)throw Error('Native user detail identity mismatch');return user;}));const matches=users.filter(u=>u.email===email&&u.active===true);if(matches.length!==1)throw Error('Native agent fixture ambiguous');return matches[0].id;}

export function nativeAgentBinding(actor,viewport,tenantId){
 assert(Number.isSafeInteger(actor?.id)&&actor.id>0);assertNativeAgent(actor,actor.id);
 assert(typeof tenantId==='string'&&tenantId.length);assert(viewport&&Number.isSafeInteger(viewport.width)&&viewport.width>0&&Number.isSafeInteger(viewport.height)&&viewport.height>0);
 const digest=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex'),actorRef=digest('zammad:'+actor.id),tenantRef=digest(tenantId),actualViewport={width:viewport.width,height:viewport.height};
 return{actorRef,tenantRef,actualViewport,verifiedContext:{role:'zammad_agent',locale:'en',actorRef,tenantRef,viewport:actualViewport,nativeActor:{id:actor.id,roles:[...actor.roles],locale:actor.locale}}};
}
export async function captureNativeAgentEvidence(page,expectedId,tenantId){return nativeAgentBinding(await verifyNativeAgentPage(page,expectedId),page.viewportSize(),tenantId);}
export function bindNativeAgentResult(row,binding){
 assert(binding?.verifiedContext);assert.equal(binding.verifiedContext.role,'zammad_agent');assert.equal(binding.verifiedContext.locale,'en');assertNativeAgent(binding.verifiedContext.nativeActor,binding.verifiedContext.nativeActor?.id);assert(/^zammad_agent-en-(desktop|tablet|mobile)$/u.test(row.contextId));
 assert.deepEqual(binding.actualViewport,binding.verifiedContext.viewport);
 if(row.actualViewport)assert.deepEqual(row.actualViewport,binding.actualViewport,'Native result viewport drift');
 return{...row,...binding,proof:{...row.proof,actorVerified:true}};
}
