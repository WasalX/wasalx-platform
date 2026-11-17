import assert from 'node:assert/strict';
import {createMetaCallbacks} from './simulation-meta-runtime.mjs';
import {assertMetaRuntimeBinding} from './simulation-meta-producer.mjs';
import {retainedFixtureStage} from './simulation-retained-fixture.mjs';

export async function retainedMetaFixtureStage(session,args) {
  const fixture=await retainedFixtureStage(session,args);
  assert.equal(fixture.connectionId!=null,fixture.runtimeBinding!=null,'Retained Meta fixture has partial runtime binding');
  if(fixture.connectionId==null){
    assert(session.metaCallbacks,'Retained Meta dependent fixture requires initialized callbacks');
    return fixture;
  }
  const callbacks=await createMetaCallbacks({...session,runId:args.namespace},args.config.meta);
  installRetainedMetaCallbacks(session,fixture,callbacks);
  return fixture;
}

export function installRetainedMetaCallbacks(session,fixture,callbacks) {
  callbacks.binding.connectionId=fixture.connectionId;assertMetaRuntimeBinding(fixture,callbacks,session);session.metaCallbacks=callbacks;
}
