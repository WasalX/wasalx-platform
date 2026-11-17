import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

test('native recipient restore changes only two saved preference keys and rejects drift',()=>{
 const root=mkdtempSync(join(tmpdir(),'wasalx-mail-restore-'));
 try{
  const state=join(root,'state.json'),stub=join(root,'rails-stub.rb');
  const fixture=fileURLToPath(new URL('../scripts/release/simulation-email/native-failure-fixture.rb',import.meta.url));
  writeFileSync(stub,`require 'json'
require 'time'
class User
  attr_accessor :preferences
  attr_reader :id, :email
  def initialize(row); @id=row.fetch('id'); @email=row.fetch('email'); @preferences=row.fetch('preferences'); if ENV['TYPED_FAILURE_TIME']=='1' && @preferences['mail_delivery_failed_data']; @preferences['mail_delivery_failed_data']['at']=Time.iso8601(@preferences['mail_delivery_failed_data'].fetch('at')); end; end
  def self.find_by(email:); row=JSON.parse(File.read(ENV.fetch('RECIPIENT_STATE_FILE'))); row && row['email']==email ? new(row) : nil; end
  def with_lock; yield; end
  def save!; File.write(ENV.fetch('RECIPIENT_STATE_FILE'),JSON.generate({'id'=>id,'email'=>email,'preferences'=>preferences})); end
end
module Delayed
  class Job
    def self.where(*); self; end
    def self.count; ENV.fetch('PENDING_EMAIL_JOBS','0').to_i; end
  end
end
`);
  const initial={id:7,email:'customer@alpha.invalid',preferences:{theme:'dark',mail_delivery_failed:false}};
  const bounced={...initial,preferences:{...initial.preferences,mail_delivery_failed:true,mail_delivery_failed_data:{at:'2026-10-07T00:00:00Z'}}};
  const run=(payload,jobs=0,typed=false)=>{
   const child=spawnSync('ruby',['-r',stub,fixture],{input:JSON.stringify({isolated:true,originalRecipient:initial.email,...payload}),encoding:'utf8',env:{...process.env,RECIPIENT_STATE_FILE:state,PENDING_EMAIL_JOBS:String(jobs),TYPED_FAILURE_TIME:typed?'1':'0'}});
   assert.ifError(child.error);
   assert.equal(child.signal,null,'Ruby fixture was interrupted');
   return child;
  };
  writeFileSync(state,JSON.stringify(initial));
  const beforeResult=run({action:'recipient-state'});assert.equal(beforeResult.status,0,beforeResult.stderr);
  const before=JSON.parse(beforeResult.stdout);
  assert.equal(before.recipientMailState.keys.mail_delivery_failed.value,false);
  writeFileSync(state,JSON.stringify(bounced));
  const afterResult=run({action:'recipient-state'});assert.equal(afterResult.status,0,afterResult.stderr);
  const after=JSON.parse(afterResult.stdout);
  assert.equal(after.recipientFailureFlag,true);
  assert.equal(after.recipientMailState.otherPreferencesSha256,before.recipientMailState.otherPreferencesSha256);
  const restore={action:'recipient-mail-restore',preBounce:before,postBounce:after,bounceProofSha256:'a'.repeat(64),restoreIntentSha256:'b'.repeat(64),ownedJobsDrained:true,uncertainOutcomesReconciled:true};
  const fail=(payload,jobs=0)=>{writeFileSync(state,JSON.stringify(bounced));const result=run({...restore,...payload},jobs);assert.notEqual(result.status,0);assert.deepEqual(JSON.parse(readFileSync(state,'utf8')),bounced);};
  fail({preBounce:{...before,userId:8}});
  fail({postBounce:{...after,recipientMailState:{...after.recipientMailState,preferencesSha256:'c'.repeat(64)}}});
  writeFileSync(state,JSON.stringify({...bounced,preferences:{...bounced.preferences,theme:'changed'}}));
  assert.notEqual(run(restore).status,0);
  writeFileSync(state,JSON.stringify({...bounced,preferences:{...bounced.preferences,mail_delivery_failed_data:{at:'2026-10-07T00:00:01Z'}}}));
  assert.notEqual(run(restore).status,0);
  fail({},1);
  writeFileSync(state,JSON.stringify(bounced));
  const accepted=run(restore);assert.equal(accepted.status,0,accepted.stderr);
  const receipt=JSON.parse(accepted.stdout);assert.equal(receipt.restored,true);
  assert.equal(receipt.recipient.recipientMailState.preferencesSha256,before.recipientMailState.preferencesSha256);
  assert.deepEqual(JSON.parse(readFileSync(state,'utf8')).preferences,initial.preferences);
  // A JSON receipt carries a string while the native preference contains a Time.
  // Both absent and explicit-false pre-bounce flags must preserve their exact presence.
  for (const priorPreferences of [{theme:'dark'},{theme:'dark',mail_delivery_failed:false}]) {
   const typedInitial={...initial,preferences:priorPreferences};
   const typedBounced={...initial,preferences:{...priorPreferences,mail_delivery_failed:true,mail_delivery_failed_data:{at:'2026-10-07T00:00:00Z'}}};
   writeFileSync(state,JSON.stringify(typedInitial));
   const typedBeforeResult=run({action:'recipient-state'},0,true);assert.equal(typedBeforeResult.status,0,typedBeforeResult.stderr);
   const typedBefore=JSON.parse(typedBeforeResult.stdout);
   writeFileSync(state,JSON.stringify(typedBounced));
   const typedAfterResult=run({action:'recipient-state'},0,true);assert.equal(typedAfterResult.status,0,typedAfterResult.stderr);
   const typedAfter=JSON.parse(typedAfterResult.stdout);
   assert.equal(typeof typedAfter.recipientMailState.keys.mail_delivery_failed_data.value.at,'string');
   assert.equal(typedAfter.recipientMailState.otherPreferencesSha256,typedBefore.recipientMailState.otherPreferencesSha256);
   const typedRestore={...restore,preBounce:typedBefore,postBounce:typedAfter};
   for(const [changed,jobs] of [
    [{...typedBounced,preferences:{...typedBounced.preferences,mail_delivery_failed_data:{at:'2026-10-07T00:00:01Z'}}},0],
    [{...typedBounced,preferences:{...typedBounced.preferences,theme:'changed'}},0],
    [typedBounced,1],
   ]) {
    const bytes=JSON.stringify(changed);writeFileSync(state,bytes);
    const denied=run(typedRestore,jobs,true);assert.notEqual(denied.status,0,denied.stdout);
    assert.equal(readFileSync(state,'utf8'),bytes,'A drift or pending-job rejection must not save');
   }
   writeFileSync(state,JSON.stringify(typedBounced));
   const acceptedTyped=run(typedRestore,0,true);assert.equal(acceptedTyped.status,0,acceptedTyped.stderr);
   const typedReceipt=JSON.parse(acceptedTyped.stdout);
   assert.equal(typedReceipt.restored,true);
   assert.deepEqual(typedReceipt.recipient.recipientMailState,typedBefore.recipientMailState);
   assert.deepEqual(JSON.parse(readFileSync(state,'utf8')).preferences,priorPreferences);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
