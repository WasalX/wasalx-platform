// Inert companion to the existing P02/P05 DEV guest/browser adapter. Root composes
// its finite action cases only after both packets are reviewed. No work on import.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
export const routingActions=Object.freeze(['routing-current','routing-admit','routing-claim','routing-observe','routing-provider-read','routing-primary','routing-fault']);
const sourcePaths=['scripts/release/meta-routing-fixture.mjs','scripts/release/meta-routing-readback.mjs','scripts/release/meta-routing-setup-journey.mjs','scripts/release/meta-thread-control-journey.mjs','scripts/release/simulation-meta-input.mjs'];
export function validateRoutingManifest(m){
 const r=m.routing;assert(r&&Object.keys(r).sort().join(',')==='connectionId,driverFiles,guestSha256,mode,native,operatorSubjectSha256,primary,runtime,sessionId,tenantName');
 assert(uuid(r.connectionId)&&uuid(r.sessionId)&&/^[a-f0-9]{64}$/u.test(r.operatorSubjectSha256)&&r.operatorSubjectSha256!==hash(m.ownerId));
 assert(typeof r.tenantName==='string'&&r.tenantName.length>0&&/^[a-f0-9]{64}$/u.test(r.guestSha256));
 assert(['known-and-browser-loss','provider-unknown','malformed-rejection'].includes(r.mode));
 assert.deepEqual(Object.keys(r.runtime).sort(),['graphOrigin','graphVersion','mode','simulationBindingSha256']);
 assert.equal(r.runtime.mode,'SIMULATED');assert.equal(r.runtime.graphOrigin,'https://graph.facebook.com');assert.equal(r.runtime.graphVersion,'v24.0');
 assert(/^[a-f0-9]{64}$/u.test(r.runtime.simulationBindingSha256));
 const primary=r.primary;assert(primary&&Object.keys(primary).sort().join(',')==='messageId,text');
 assert.equal(primary.messageId,'wamid.synthetic.'+m.runId+'.initial');assert.equal(primary.text,'Synthetic routing '+m.runId);
 for(const path of sourcePaths)assert(m.sourceFiles.some(f=>f.path===path&&/^[a-f0-9]{64}$/u.test(f.sha256)),'Routing helper source closure missing');
}
