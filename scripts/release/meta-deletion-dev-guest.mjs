// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Fixed P11 extension of the existing admitted DEV guest. No work on import.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {request} from 'node:http';
import {execFile} from 'node:child_process';
import {deletionSha as sha,deletionRequire as need,deletionSafe,metaDeletionWireInventory,validateDeletionReceipt,deletionKinds,metaDeletionDevReceiptSql} from './meta-deletion-dev-fixture.mjs';
const {join,dirname}=posix,hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/u.test(x);
const env=c=>Object.fromEntries(c.Config.Env.map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));
// Exact root-reviewed composed bytes; original private SQL remains provenance.
export function validateDeletionMigrationBinding(migration,sourceFiles){
 need(typeof migration?.path==='string'&&/^services\/control-api\/migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/u.test(migration.path)&&hex(migration.sha256)&&hex(migration.rootReviewSha256)&&migration.historicalProposalSha256==='91f24a615f3e9e970593a7b2346d766c1b3f0e9a027c87da24f45a0c107be5ec'&&Array.isArray(sourceFiles)&&sourceFiles.filter(f=>f.path===migration.path&&f.sha256===migration.sha256).length===1,'P11_MIGRATION');
}
export function validateDeletionMigrationLedger(migration,ledger){need(ledger?.length===1&&ledger[0].name===migration.path.split('/').at(-1)&&ledger[0].checksum_sha256===migration.sha256,'MIGRATION_NOT_INSTALLED');}
export function validateDeletionInstalledConfiguration(e,p){try{
 need(e.META_DELETION_STATUS_ORIGIN===p.statusOrigin&&e.META_DELETION_REFUSAL_POLICY_URL===p.refusalPolicyUrl&&e.META_DELETION_HELP_URL===p.helpUrl&&Number(e.META_DELETION_MAX_REQUEST_AGE_SECONDS)===p.maxAgeSeconds&&Number(e.META_DELETION_RECEIPT_RETENTION_DAYS)===p.retentionDays,'DELETION_CONFIG');
 const help=new URL(e.META_DELETION_HELP_URL);need(help.protocol==='https:'&&!help.username&&!help.password&&!help.search&&!help.hash&&help.href===p.helpUrl,'DELETION_CONFIG');
 }catch{throw Error('P11 DELETION_CONFIG');}
}
export function validateDeletionPreservation(row){need(row&&Number.isSafeInteger(row.count)&&row.count>=0&&row.count<=2000&&hex(row.sha256)&&row.maintenance_eligible===false,'GLOBAL_MAINTENANCE_WINDOW');return{count:row.count,sha256:row.sha256};}
export const metaDeletionPreservationSql=`SELECT json_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(value::text,E'\\n' ORDER BY value::text),''),'UTF8')),'hex'),
 'maintenance_eligible',coalesce(bool_or(state='REFUSED' AND ((minimized_at IS NULL AND expires_at<=to_timestamp($3/1000.0)) OR replay_until<=to_timestamp($3/1000.0))),false))
 FROM (SELECT to_jsonb(r) value,state,minimized_at,expires_at,replay_until FROM public.meta_deletion_receipts r
 WHERE NOT (r.app_id=$1 AND r.payload_sha256=$2) ORDER BY r.id LIMIT 2001) q`;
async function checkedClaim(m,manifestSha256){
 const path=join(m.fixture.privateDir,'p11-'+m.runId+'.claim.json'),s=await lstat(path);
 need(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&await realpath(path)===path,'CLAIM_FILE');
 const value=JSON.parse(await readFile(path));need(value.manifestSha256===manifestSha256&&value.namespace===m.p11.namespace,'CLAIM_BINDING');return value;
}
const tenantTables=['connections','provider_sessions','event_inbox','normalized_messages','delivery_outbox','audit_events','privacy_jobs','secret_cleanup_outbox','meta_signup_attempts','bot_conversations','bot_action_jobs','bot_handoff_jobs','direct_native_reply_intents','direct_customer_close_commands'];
export function deletionPublicReceipt(row){if(!row)return null;const out={};for(const key of ['id','app_id','payload_sha256','locator','state','version','received_at','expires_at','replay_until','minimized_at','refusal_policy_url','operation_count','review_audit_count'])out[key]=row[key];return out;}
export async function postDeletionCallback(ip,wire,validUntil,requestFn=request){return deletionSafe(()=>new Promise((resolveResult,reject)=>{
 const end=Date.parse(validUntil),remaining=end-Date.now();need(Number.isSafeInteger(end)&&remaining>0,'CALLBACK_ADMISSION');
 const budget=Math.min(8000,remaining);let q,response,timer,done=false;
 const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(error){response?.destroy();q?.destroy();reject(Error('P11 CALLBACK_UNKNOWN_NO_REPLAY'));}else resolveResult(result);};
 // A total header/body deadline, not just the socket inactivity timeout.
 timer=setTimeout(()=>finish(Error('deadline')),budget);
 try{q=requestFn({host:ip,port:3001,path:'/webhooks/meta/data-deletion',method:'POST',timeout:budget,headers:{'content-type':wire.mime,'content-length':wire.body.length}},r=>{
  response=r;if(done){r.destroy();return;}let size=0;const chunks=[];
  r.on('data',b=>{size+=b.length;if(size>8192)finish(Error('bound'));else chunks.push(b);});r.on('error',()=>finish(Error('response')));
  r.on('end',()=>{try{need(![301,302,303,307,308].includes(r.statusCode),'REDIRECT');const body=r.statusCode===200?JSON.parse(Buffer.concat(chunks)):null;finish(null,{status:r.statusCode,body});}catch{finish(Error('response'));}});
 });q.on('timeout',()=>finish(Error('inactivity')));q.on('error',()=>finish(Error('request')));q.end(wire.body);}catch{finish(Error('request'));}
}),'CALLBACK_UNKNOWN_NO_REPLAY');}
// Fixed read-only cookie-selected session/JWT verifier. Credential-bearing
// input uses stdin only; no session, bearer, Redis URL or private actor output.
export function validatePlatformIdentityConfiguration(e,portal,p){
 need(e.PLATFORM_OPERATOR_OIDC_ISSUER?.replace(/\/+$/u,'')===p.platform.issuer&&e.PLATFORM_OPERATOR_OIDC_AUDIENCE===p.platform.audience&&e.OIDC_AUDIENCE===p.ordinaryAudience&&e.OIDC_ISSUER?.replace(/\/+$/u,'')===p.ordinaryIssuer&&Number(e.PLATFORM_OPERATOR_MAX_AUTH_AGE_SECONDS??900)===p.platform.maxAuthAgeSeconds&&portal.PLATFORM_OPERATOR_OIDC_ISSUER?.replace(/\/+$/u,'')===p.platform.issuer,'PLATFORM_CONFIG');
}
export function validatePlatformIdentity(actual,p,now=Math.floor(Date.now()/1000)){
 need(actual.verified===true&&actual.subjectSha256===p.subjectSha256&&actual.emailSha256===p.emailSha256&&Number.isInteger(actual.authenticatedAt)&&actual.authenticatedAt<=now+5&&now-actual.authenticatedAt<=p.maxAuthAgeSeconds&&actual.expiresAt>now+10,'PLATFORM_IDENTITY');return actual;
}
export async function platformIdentity(m,bound,sessionId){
 validatePlatformIdentityConfiguration(env(bound.containers['control-api']),env(bound.containers.portal),m.p11);
 need(typeof sessionId==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(sessionId),'PLATFORM_COOKIE');
 const e=env(bound.containers.portal),url=e.PLATFORM_PORTAL_SESSION_REDIS_URL??e.PORTAL_SESSION_REDIS_URL??e.REDIS_URL;need(typeof url==='string','SESSION_STORE');
 const script=`const c=require('node:crypto');(async()=>{let b='';for await(const x of process.stdin){b+=x;if(b.length>8192)throw Error()}const input=JSON.parse(b),{default:Redis}=await import('ioredis'),{validatedRedisUrl}=await import('@wasalx/core/redis-security'),{PlatformOperatorAuthService}=await import('/app/dist/platform-operator-auth.js');const r=new Redis(validatedRedisUrl(input.redisUrl,process.env,'PLATFORM_PORTAL_SESSION_REDIS_URL'),{maxRetriesPerRequest:0,connectTimeout:5000,commandTimeout:5000,lazyConnect:true});try{await r.connect();const raw=await r.get('wasalx:platform-portal:session:'+input.sessionId);if(!raw||raw.length>16384)throw Error();const s=JSON.parse(raw),now=Math.floor(Date.now()/1000);if(s.version!==1||typeof s.accessToken!=='string'||typeof s.csrfToken!=='string'||!s.csrfToken||!Number.isInteger(s.authenticatedAt)||!Number.isInteger(s.expiresAt)||s.expiresAt<=now+10)throw Error();const p=await new PlatformOperatorAuthService().authenticate('Bearer '+s.accessToken);if(p.subject!==s.subject||p.email!==s.email||p.authenticatedAt!==s.authenticatedAt)throw Error();const sha=v=>c.createHash('sha256').update(v).digest('hex');process.stdout.write(JSON.stringify({verified:true,subjectSha256:sha(p.subject),emailSha256:sha(p.email),authenticatedAt:p.authenticatedAt,expiresAt:s.expiresAt}))}finally{r.disconnect()}})().catch(()=>{process.stderr.write('P11 platform verification unavailable');process.exitCode=1});`;
 const bytes=await new Promise((accept,reject)=>{
  const child=execFile('docker',['exec','-i','--workdir','/app',bound.containers['control-api'].Id,'node','-e',script],{cwd:m.candidate.root,encoding:'utf8',timeout:20000,maxBuffer:4096},(error,stdout)=>error?reject(Error('P11 PLATFORM_VERIFY')):accept(stdout));
  child.stdin.on('error',()=>reject(Error('P11 PLATFORM_VERIFY')));child.stdin.end(JSON.stringify({sessionId,redisUrl:url}));
 });
 const actual=JSON.parse(bytes),p=m.p11.platform,now=Math.floor(Date.now()/1000);
 return validatePlatformIdentity(actual,p,now);
}
