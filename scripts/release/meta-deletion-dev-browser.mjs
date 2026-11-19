// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Installed DEV composition. Root supplies its existing separately signed-in
// platform Page and an owned cookie-free public Page; no sign-in or launcher.
import {isDeepStrictEqual} from 'node:util';
import {deletionRequire as need,deletionSafe} from './meta-deletion-dev-fixture.mjs';
import {runMetaDeletionDevJourney} from './meta-deletion-journey.mjs';

export async function verifyDeletionPlatformPage(page,m,relay){return deletionSafe(async()=>{
 need(new URL(page.url()).origin===m.origin,'PAGE_ORIGIN');
 const cookies=await page.context().cookies(m.origin),name='wasalx_platform_session';
 need(!cookies.some(c=>['wasalx_session','__Host-wasalx_session'].includes(c.name)),'PLATFORM_TENANT_COOKIE');
 const selected=cookies.filter(c=>c.name===name);need(selected.length===1&&!cookies.some(c=>c.name==='__Host-wasalx_platform_session'),'PLATFORM_SESSION');
 // The exact HttpOnly, origin-selected session ID stays in relay stdin; the
 // guest does readonly Redis GET plus the real product JWT/MFA verifier.
 const actor=await relay('platform-verify',{sessionId:selected[0].value});
 need(actor.verified===true&&actor.subjectSha256===m.p11.platform.subjectSha256&&actor.emailSha256===m.p11.platform.emailSha256,'PLATFORM_PRINCIPAL');
 const served=await page.evaluate(async()=>{const r=await fetch('/api/platform-console/operations/overview',{cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});return{status:r.status,url:r.url};});
 need(served.status===200&&served.url===m.origin+'/api/platform-console/operations/overview','PLATFORM_CURRENT_REQUEST');return true;
},'PLATFORM_VERIFY');}

export async function composeDeletionDevJourney({m,platformPage,publicPage,relay,labels,capture,checkpoint,lease}){
 return deletionSafe(async()=>{
  let originalNonfixture;
  const remoteAdmit=async()=>{await lease();const admitted=await relay('admit');need(admitted.admitted===true&&admitted.namespace===m.p11.namespace&&admitted.nonfixtureReceipts&&Number.isSafeInteger(admitted.nonfixtureReceipts.count)&&/^[0-9a-f]{64}$/u.test(admitted.nonfixtureReceipts.sha256),'REMOTE_ADMISSION');
   if(originalNonfixture)need(isDeepStrictEqual(admitted.nonfixtureReceipts,originalNonfixture),'GLOBAL_RECEIPTS_CHANGED');else originalNonfixture=structuredClone(admitted.nonfixtureReceipts);await lease();return admitted;};
  const first=await remoteAdmit();const verified=async page=>verifyDeletionPlatformPage(page,m,relay);
  await verified(platformPage);need(!(await publicPage.context().cookies(m.origin)).some(c=>['wasalx_platform_session','__Host-wasalx_platform_session','wasalx_session','__Host-wasalx_session'].includes(c.name)),'PUBLIC_COOKIE');
  const fixture=await createDeletionRelayFixture({m,relay,lease,admitted:first});
  return runMetaDeletionDevJourney({platformPage,publicPage,origin:m.origin,statusOrigin:m.p11.statusOrigin,refusalPolicyUrl:m.p11.refusalPolicyUrl,fixture,labels,verifyPlatform:verified,admit:remoteAdmit,lease,capture,checkpoint});
 },'COMPOSITION_STOPPED_NO_REPLAY');
}
export async function createDeletionRelayFixture({m,relay,lease,admitted}){return deletionSafe(async()=>{
 need(admitted?.admitted===true&&admitted.namespace===m.p11.namespace&&/^[0-9a-f]{64}$/u.test(admitted.fixtureSha256),'RELAY_ADMISSION');
 await lease();const claimed=await relay('claim');need(claimed.claimed===true&&claimed.runId===m.p11.namespace&&claimed.fixtureSha256===admitted.fixtureSha256,'CLAIM');
 return{namespace:m.p11.namespace,fixtureSha256:claimed.fixtureSha256,
  dispatch:kind=>deletionSafe(async()=>{await lease();return relay('dispatch',{kind});},'RELAY_DISPATCH_NO_REPLAY'),
  observe:()=>deletionSafe(async()=>{await lease();return relay('observe');},'RELAY_OBSERVE'),
  reviewObserve:()=>deletionSafe(async()=>{await lease();return relay('review-observe');},'RELAY_REVIEW_OBSERVE'),
  verifyNegatives:expected=>deletionSafe(async()=>{await lease();need(isDeepStrictEqual(await relay('negative-observe'),expected),'NEGATIVE_CHANGED');},'RELAY_NEGATIVE'),
  verifyNoEffects:()=>deletionSafe(async()=>{await lease();await relay('negative-observe');},'RELAY_EFFECTS')};
},'RELAY_FIXTURE');}

