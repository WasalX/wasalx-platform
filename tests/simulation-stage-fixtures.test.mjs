import assert from 'node:assert/strict';
import test from 'node:test';
import {validateStatusFixture,runMetaDeliveryStatuses} from '../scripts/release/simulation-meta-status.mjs';
const fixture=()=>({evidenceMode:'simulated',provider:'META',tenantId:'tenant-a',connectionId:'connection-a',deliveries:[{deliveryId:'delivery-a',externalMessageId:'wamid.unique-a',recipient:'12025550103'}]});
test('accepts explicit producer identities without retained database IDs',()=>{const f=fixture();assert.equal(validateStatusFixture(f,'status-next'),f);});
test('rejects unsafe or ambiguous fixtures before any database/provider effect',async()=>{
 const bad=[{...fixture(),provider:'WAHA'},{...fixture(),evidenceMode:'live'},{...fixture(),deliveries:[]},{...fixture(),deliveries:[fixture().deliveries[0],fixture().deliveries[0]]},{...fixture(),deliveries:[{...fixture().deliveries[0],recipient:'not-a-phone'}]}];
 for(const f of bad)await assert.rejects(runMetaDeliveryStatuses({fixture:f,runId:'status-next',scoped:()=>assert.fail('No database read'),postRaw:()=>assert.fail('No dispatch')}));
 assert.throws(()=>validateStatusFixture(fixture(),'../escape'));
});
test('producer identity mismatch fails before status dispatch or claim',async()=>{
 await assert.rejects(runMetaDeliveryStatuses({fixture:fixture(),runId:'status-next',scoped:async()=>[{id:'another-delivery',external_message_id:'wamid.unique-a',external_chat_id:'12025550103',state:'SENT',attempts:1}],postRaw:()=>assert.fail('No dispatch')}),/Unexpected delivery identity/);
});
