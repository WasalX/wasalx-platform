import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export async function safeNavigationDiagnostics(response,page){
  const requests=[];let request=response?.request?.();
  while(request){requests.push(request);request=request.redirectedFrom?.();}
  const redirects=[];
  for(const item of requests.reverse()){
    const url=new URL(item.url());const itemResponse=await item.response?.();
    redirects.push({status:itemResponse?.status?.()??null,origin:url.origin,pathname:url.pathname});
  }
  const finalUrl=new URL(page.url());
  return{redirects,final:{status:response?.status?.()??null,origin:finalUrl.origin,pathname:finalUrl.pathname}};
}

// Adapted from existing session-rotation-live-probe.mjs, retaining actual cookie
// rotation/stale-browser assertions without its historical host/SHA hardcoding.
// Main supplies existing pending-login helper, enrolled factor and Redis readback.
export async function runSessionRotationPacket({browser,page,origin,keycloakOrigin,runId,
  actorId,tenantId,role,assertIsolatedRuntime,assertActor,readMembership,sessionExists,
  authenticatePending,checkpoint,identity:identityOverride,cookieName="wasalx_session",authorizedPath="/api/workspaces",
  reauthenticationPath,terminalPath="/app",assertStaleUi}) {
  assert.match(runId,/^[A-Za-z0-9_-]{1,60}$/);
  assert.equal(typeof sessionExists,'function');assert.equal(typeof authenticatePending,'function');
  const diagnostic=async(step,details={})=>{try{await checkpoint({phase:'diagnostic',scenario:'session-rotation',step,...details})}catch{/* Diagnostics must not affect qualification. */}};
  await diagnostic('started');
  await assertIsolatedRuntime({origin,evidenceMode:'simulated'});
  await page.setViewportSize({width:1440,height:1000});
  await diagnostic('runtime-verified');
  const identity=identityOverride??(async target=>{
    await assertActor(target);
    const spaces=await target.evaluate(async()=>{
      const r=await fetch('/api/workspaces',{cache:'no-store',credentials:'same-origin'});
      if(r.status!==200)throw Error('Workspace identity unavailable');return (await r.json()).data;
    });
    assert(spaces.some(x=>x.current&&x.id===tenantId&&x.role===role));
    const m=await readMembership();assert.equal(m.user_id,actorId);assert.equal(m.role,role);assert.equal(m.state,'ACTIVE');
    return {actorRef:'sha256:'+createHash('sha256').update(actorId).digest('hex'),
      tenantRef:'sha256:'+createHash('sha256').update(tenantId).digest('hex'),role,matched:true};
  });
  const startedAt=new Date().toISOString(),before=await identity(page);
  await diagnostic('identity-verified');
  let oldCookie=(await page.context().cookies(origin)).find(c=>c.name===cookieName);
  assert(oldCookie?.httpOnly);assert.equal(oldCookie.sameSite,'Lax');
  assert.equal(await sessionExists(oldCookie.value),true);
  await diagnostic('current-session-verified');
  const stale=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});
  let staleClosed=false;
  try {
    await stale.addCookies([oldCookie]);
    const staleBefore=await stale.request.get(origin+authorizedPath);assert.equal(staleBefore.status(),200);
    await diagnostic('stale-session-verified');
    await checkpoint({phase:'intent',step:'session-rotation',runId,startedAt,before,oldSessionExists:true});
    await page.goto(reauthenticationPath??origin+'/auth/login?step_up=privileged&return_to=/app&tenant_id='+encodeURIComponent(tenantId));
    assert.equal(new URL(page.url()).origin,keycloakOrigin);
    await authenticatePending(page); // reuse loginWithFactor(page,factor.readOtp)
    assert.equal(new URL(page.url()).origin,origin);assert.equal(new URL(page.url()).pathname,terminalPath);
    const after=await identity(page);
    const freshCookie=(await page.context().cookies(origin)).find(c=>c.name===cookieName);
    assert(freshCookie?.httpOnly);assert.equal(freshCookie.sameSite,'Lax');assert.notEqual(freshCookie.value,oldCookie.value);
    assert.equal(await sessionExists(freshCookie.value),true);assert.equal(await sessionExists(oldCookie.value),false);
    await checkpoint({phase:'proof',step:'session-rotated',at:new Date().toISOString(),cookieRotated:true,oldSessionDeleted:true,newSessionExists:true,after});
    await page.reload();assert.deepEqual(await identity(page),before);
    const staleAfter=await stale.request.get(origin+authorizedPath);assert.equal(staleAfter.status(),401);
    const stalePage=await stale.newPage();const staleNavigationResponse=await stalePage.goto(origin+terminalPath);
    let navigation;try{navigation=await safeNavigationDiagnostics(staleNavigationResponse,stalePage);}catch{const u=new URL(stalePage.url());navigation={redirects:[],final:{status:null,origin:u.origin,pathname:u.pathname}};}
    await diagnostic('stale-ui-navigation',{navigation});
    if(assertStaleUi)await assertStaleUi(stalePage,navigation);else{await stalePage.getByRole('button',{name:'Sign in',exact:true}).waitFor({state:'visible',timeout:15000});assert.equal(new URL(stalePage.url()).origin,keycloakOrigin);}
    assert.equal(new URL(stalePage.url()).origin,keycloakOrigin);
    const staleViewport=stalePage.viewportSize(),staleLocale=await stalePage.evaluate(()=>document.documentElement.lang);
    assert.deepEqual(staleViewport,{width:1440,height:1000});assert(/^en(?:[-_]|$)/iu.test(staleLocale));
    const staleAnonymousBinding={role:'anonymous',locale:'en',actorRef:null,tenantRef:null,viewport:staleViewport,authenticationDenied:staleAfter.status()===401};
    await stale.close();staleClosed=true;
    const result={evidenceMode:'simulated',startedAt,finishedAt:new Date().toISOString(),runId,
      role,locale:'en',viewport:{width:1440,height:1000},before,after,cookieRotated:true,
      oldSessionDeleted:true,newSessionExists:true,staleBeforeHttp:200,staleAfterHttp:401,
      staleUiRequiresSignIn:true,reloadIdentityMatched:true,staleAnonymousBinding,
      cleanup:{ownedStaleContextClosed:true,newAuthorizedSessionPreserved:true},
      limitations:['This actor only; invitation and revocation tests are separate. No SMTP/provider event used.']};
    await checkpoint({phase:'proof',step:'stale-session-denied',proof:result});return result;
  } finally {oldCookie=undefined;if(!staleClosed)await stale.close();}
}
