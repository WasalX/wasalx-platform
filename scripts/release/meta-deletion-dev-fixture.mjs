// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Inert, finite synthetic callback fixture. Private values never enter errors.
import {createHash,createHmac} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const deletionSha=value=>createHash('sha256').update(value).digest('hex');
export function deletionRequire(value,reason='CONTRACT'){if(!value)throw Error('P11 '+reason);}
export async function deletionSafe(fn,reason){try{return await fn();}catch{throw Error('P11 '+reason);}}
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/u.test(value);
export const metaDeletionDevReceiptSql=`SELECT id,app_id,subject_namespace,subject_digest,payload_sha256,verification_key_fingerprint,source_contract_sha256,admission_policy,locator,state,version,received_at,expires_at,replay_until,minimized_at,refusal_policy_url,
 (SELECT count(*)::integer FROM public.meta_deletion_review_operations o WHERE o.receipt_id=r.id) AS operation_count,
 (SELECT count(*)::integer FROM public.platform_operations_audit_events a WHERE a.target_type='meta.deletion.receipt' AND a.target_id=r.id::text AND a.action='meta.deletion.review') AS review_audit_count,
 (SELECT count(*)::integer FROM public.platform_operations_audit_events a WHERE a.target_type='meta.deletion.receipt' AND a.target_id=r.id::text AND a.action='meta.deletion.review' AND encode(sha256(convert_to(a.operator_subject,'UTF8')),'hex')<>$3) AS foreign_actor_count
 FROM public.meta_deletion_receipts r WHERE r.app_id=$1 AND r.payload_sha256=$2 LIMIT 2`;
export const deletionKinds=['valid','duplicate','invalid-signature','wrong-mime','malformed','old-new'];
// Secret-bearing output is guest/process memory only, never a descriptor/checkpoint.
export function metaDeletionWireInventory({namespace,appId,issuedAt,appSecret}){
 deletionRequire(/^p11-[A-Za-z0-9_-]{8,80}$/u.test(namespace)&&/^[0-9]{1,32}$/u.test(appId)&&Number.isSafeInteger(issuedAt)&&issuedAt>0&&typeof appSecret==='string'&&Buffer.byteLength(appSecret)>=16,'INPUT');
 const subject=BigInt('0x'+deletionSha('wasalx:p11:synthetic:'+namespace).slice(0,24)).toString();
 const encode=p=>Buffer.from(JSON.stringify(p)).toString('base64url'),sign=e=>createHmac('sha256',appSecret).update(e,'ascii').digest('base64url')+'.'+e;
 const payload={algorithm:'HMAC-SHA256',issued_at:issuedAt,user_id:subject,expires:0},encoded=encode(payload),signed=sign(encoded);
 const bad=Buffer.from(signed.split('.')[0],'base64url');bad[0]^=1;
 const oldEncoded=encode({...payload,issued_at:issuedAt-2592302});
 const make=(wire,mime='application/x-www-form-urlencoded')=>({body:Buffer.from(mime==='application/json'?JSON.stringify({signed_request:wire}):new URLSearchParams({signed_request:wire}).toString()),mime,payloadSha256:wire.includes('.')?deletionSha(wire.split('.')[1]):deletionSha(wire)});
 const wires={valid:make(signed),duplicate:make(signed),'invalid-signature':make(bad.toString('base64url')+'.'+encoded),'wrong-mime':make(signed,'application/json'),malformed:make('not-a-signed-envelope'),'old-new':make(sign(oldEncoded))};
 const keyFingerprint=createHmac('sha256',appSecret).update('wasalx:meta-deletion:verification-key:v1').digest('hex'),subjectDigest=createHmac('sha256',appSecret).update(`wasalx:meta-deletion:facebook-asid:v1:${appId}:${subject}`).digest('hex');
 const payloadSha256=deletionSha(encoded),fixtureSha256=deletionSha(JSON.stringify({namespace,appId,issuedAt,payloadSha256,keyFingerprint}));
 return{wires,keyFingerprint,subjectDigest,payloadSha256,fixtureSha256,distinctNegativeHashes:[wires.malformed.payloadSha256,wires['old-new'].payloadSha256]};
}
export function validateDeletionReceipt(row,inventory,appId){
 deletionRequire(row&&row.app_id===appId&&row.payload_sha256===inventory.payloadSha256&&row.subject_namespace==='FACEBOOK_ASID'&&row.subject_digest===inventory.subjectDigest&&row.verification_key_fingerprint===inventory.keyFingerprint&&row.source_contract_sha256==='454eeedfa72e8f229c02afb78f11ea6579cebc0360906af171b7f282e8c2f539'&&row.admission_policy==='META_DELETION_LOCAL_V1_MAX2592000_SKEW300'&&hash(row.locator)&&Number(row.foreign_actor_count??0)===0,'RECEIPT_BINDING');
}
export async function createMetaDeletionDevFixture(input){return deletionSafe(async()=>{
 const {namespace,appId,admit,claim,postRaw,readReceipt,readEffects,checkpoint}=input;
 deletionRequire(!['DEBUG','PWDEBUG','DEBUG_FILE','PW_TEST_TRACE_VIEWER','PW_TRACE_DIR'].some(k=>process.env[k]),'RECORDING');
 for(const fn of [admit,claim,postRaw,readReceipt,readEffects,checkpoint])deletionRequire(typeof fn==='function','ADAPTER');
 const inventory=metaDeletionWireInventory(input),consumed=new Set();let confirmed=false,attempted=false;
 await admit();deletionRequire(await readReceipt(appId,inventory.payloadSha256)===null,'CONSUMED');
 for(const h of inventory.distinctNegativeHashes)deletionRequire(await readReceipt(appId,h)===null,'NEGATIVE_CONSUMED');
 const before=structuredClone(await readEffects());deletionRequire(before&&typeof before==='object','EFFECTS');
 await admit();const claimed=await claim({namespace,issuedAt:input.issuedAt,fixtureSha256:inventory.fixtureSha256});
 deletionRequire(claimed?.claimed===true&&claimed.runId===namespace&&claimed.fixtureSha256===inventory.fixtureSha256,'CLAIM');
 const noEffects=async()=>deletionRequire(isDeepStrictEqual(await readEffects(),before),'EFFECT_CHANGED');
 const observe=()=>deletionSafe(async()=>{await admit();const row=await readReceipt(appId,inventory.payloadSha256);if(row){validateDeletionReceipt(row,inventory,appId);if(attempted)confirmed=true;}await noEffects();return row;},'OBSERVE');
 const negatives=expected=>deletionSafe(async()=>{await admit();for(const h of inventory.distinctNegativeHashes)deletionRequire(await readReceipt(appId,h)===null,'NEGATIVE_RECEIPT');deletionRequire(isDeepStrictEqual(await observe(),expected),'ORIGINAL_CHANGED');},'NEGATIVE_OBSERVE');
 const dispatch=kind=>deletionSafe(async()=>{
  deletionRequire(deletionKinds.includes(kind)&&!consumed.has(kind),'CONSUMED');if(kind==='duplicate')deletionRequire(confirmed,'ORIGINAL_UNCONFIRMED');
  await admit();await checkpoint({phase:'p11-callback-intent',namespace,kind,requestSha256:deletionSha(inventory.wires[kind].body),fixtureSha256:inventory.fixtureSha256});consumed.add(kind);if(kind==='valid')attempted=true;
  await admit();return deletionSafe(()=>postRaw('/webhooks/meta/data-deletion',inventory.wires[kind].body,{'content-type':inventory.wires[kind].mime}),'CALLBACK_UNKNOWN_NO_REPLAY');
 },'DISPATCH_STOPPED_NO_REPLAY');
 return{namespace,fixtureSha256:inventory.fixtureSha256,payloadSha256:inventory.payloadSha256,dispatch,observe,verifyNegatives:negatives,verifyNoEffects:()=>deletionSafe(noEffects,'EFFECTS'),limitations:['Synthetic only','No human ASID grant association']};
},'FIXTURE_STOPPED');}
