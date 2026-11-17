import assert from 'node:assert/strict';
import test from 'node:test';
import {deliveryFailureGuidance,visibleReviewMetadata} from '../lib/operator-ui.ts';

test('resolved reviews remove stale confirmation in normal and diagnostic presentation',()=>{
 const metadata={attempt_count:2,retry_requires_confirmation:true};
 for(const diagnostic of [false,true]){
  assert.deepEqual(visibleReviewMetadata(metadata,diagnostic,'RESOLVED'),[['attempt_count',2]]);
  assert.equal(visibleReviewMetadata(metadata,diagnostic,'OPEN').length,2);
 }
});
test('only latest authoritative known terminal rejection gets template guidance',()=>{
 const known={attempt_number:1,state:'FAILED_TERMINAL',provider_code:'META_CUSTOMER_WINDOW_CLOSED'};
 const row={state:'FAILED_TERMINAL',delivery_attempts:[known]};
 assert.equal(deliveryFailureGuidance(row),'tenant.deliveries.windowClosedGuidance');
 assert.equal(deliveryFailureGuidance({...row,state:'OUTCOME_UNKNOWN'}),null);
 assert.equal(deliveryFailureGuidance({...row,delivery_attempts:[{attempt_number:2,state:'OUTCOME_UNKNOWN'},known]}),null);
 assert.equal(deliveryFailureGuidance({...row,delivery_attempts:[{...known,provider_code:null}],safe_error:'META_CUSTOMER_WINDOW_CLOSED'}),null);
});
