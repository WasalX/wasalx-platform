import assert from 'node:assert/strict';
import test from 'node:test';
import {numberReleaseIntentKey,numberReleaseReadbackMatches,parseNumberReleaseAcknowledgment,parseNumberReleaseBody,parseNumberReleaseIntent,parseNumberReleaseView,sameNumberReleaseBody,type NumberReleaseIntent} from '../lib/meta-number-release-intent.ts';
const id=(n:number)=>`79000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const body={routeId:id(4),phoneNumberId:'1234567890',disconnectOperationId:id(5)};
const view={...body,releaseId:null,state:'REVOKED',reconnectRequiresNewConnection:true as const};
const intent:NumberReleaseIntent={version:1,tenantId:id(1),actorId:id(2),connectionId:id(3),key:id(6),body,uncertain:true,acknowledgmentId:null};

test('release bindings and acknowledgments reject unsafe or incomplete server data',()=>{
  assert.deepEqual(parseNumberReleaseBody(body),body);
  assert.deepEqual(parseNumberReleaseView(view),view);
  assert.deepEqual(parseNumberReleaseView({...view,disconnectOperationId:null}),{...view,disconnectOperationId:null});
  assert.deepEqual(parseNumberReleaseView({...view,releaseId:id(7)}),{...view,releaseId:id(7)});
  for(const value of [null,[],{}, {...body,routeId:'wrong'},{...body,routeId:id(4)+'\n'},{...body,disconnectOperationId:null},
    {...body,phoneNumberId:' 1234567890'},{...body,phoneNumberId:'1234567890\n'},{...body,phoneNumberId:'1234'},{...body,phoneNumberId:'1'.repeat(33)},{...body,auditNote:'extra'}])assert.throws(()=>parseNumberReleaseBody(value));
  for(const value of [null,[],{}, {...view,state:'WORKING'},{...view,reconnectRequiresNewConnection:false},{...view,releaseId:''},
    {...view,releaseId:id(7),disconnectOperationId:null},{...view,disconnectOperationId:undefined},{...view,phoneNumberId:'<private>'}])assert.throws(()=>parseNumberReleaseView(value));
  const ack={id:id(7),released:true,duplicate:false,reconnectRequiresNewConnection:true};
  assert.equal(parseNumberReleaseAcknowledgment(ack),id(7));assert.equal(parseNumberReleaseAcknowledgment({...ack,duplicate:true}),id(7));
  for(const value of [null,[],{}, {...ack,id:'wrong'},{...ack,released:false},{...ack,duplicate:'false'},{...ack,reconnectRequiresNewConnection:false}])assert.throws(()=>parseNumberReleaseAcknowledgment(value));
  assert.equal(sameNumberReleaseBody(body,{...body}),true);
  for(const changed of [{...body,routeId:id(8)},{...body,phoneNumberId:'9876543210'},{...body,disconnectOperationId:id(9)}])assert.equal(sameNumberReleaseBody(body,changed),false);
});

test('unknown release recovery retains exact key and binding only in the authenticated tab context',()=>{
  const parse=(value:unknown)=>parseNumberReleaseIntent(JSON.stringify(value),id(1),id(2),id(3));
  assert.equal(parseNumberReleaseIntent(null,id(1),id(2),id(3)),null);
  assert.deepEqual(parse(intent),intent);assert.deepEqual(parse({...intent,uncertain:false}),{...intent,uncertain:false});
  for(const scope of [[id(9),id(2),id(3)],[id(1),id(9),id(3)],[id(1),id(2),id(9)]]){
    assert.throws(()=>parseNumberReleaseIntent(JSON.stringify(intent),scope[0],scope[1],scope[2]));
    assert.notEqual(numberReleaseIntentKey(...scope as [string,string,string]),numberReleaseIntentKey(id(1),id(2),id(3)));
  }
  for(const value of [{...intent,version:2},{...intent,key:'new'},{...intent,uncertain:undefined},{...intent,uncertain:'true'},
    {...intent,body:{...body,phoneNumberId:12345}},{...intent,token:'must not persist'},null,[]])assert.throws(()=>parse(value));
  assert.throws(()=>parseNumberReleaseIntent('{',id(1),id(2),id(3)));
  assert.throws(()=>parseNumberReleaseIntent(' '.repeat(4097),id(1),id(2),id(3)));
});

test('only original binding and matching known acknowledgment settle an unknown release',()=>{
 const released={...view,releaseId:id(7)} as const;
 assert.equal(numberReleaseReadbackMatches(intent,released),true);
 assert.equal(numberReleaseReadbackMatches({...intent,acknowledgmentId:id(7)},released),true);
 for(const changed of [{...released,routeId:id(8)},{...released,phoneNumberId:'9876543210'},{...released,disconnectOperationId:id(9)},{...released,releaseId:null}])assert.equal(numberReleaseReadbackMatches(intent,changed),false);
 assert.equal(numberReleaseReadbackMatches({...intent,acknowledgmentId:id(8)},released),false);
});
