import assert from 'node:assert/strict';
// Read-only audit adapter must return ALL mode events newer than the preimage
// version, plus a private configuration digest excluding telemetry and mode.
export function restorationVersion({before,current,configurationBefore,configurationCurrent,assignmentsBefore,assignmentsCurrent,modeEvents,ownedDrain}) {
 assert(current, 'Original worker missing');
 assert.deepEqual(configurationCurrent,configurationBefore,'Worker registration configuration changed');
 assert.deepEqual(assignmentsCurrent,assignmentsBefore,'Original assignments changed');
 for(const key of ['workerKey','engine','capacity','rolloutMode']) assert.equal(current[key],before[key],`Worker ${key} changed`);
 assert.equal(current.canarySessionLimit??null,before.canarySessionLimit??null,'Canary limit changed');
 assert.ok(Number.isSafeInteger(current.version)&&current.version>=before.version,'Worker version regressed');
 // Every mode writer increments version and audits atomically. Health events
 // are not mode events. Require the exact captured owned event, not its reason.
 if(modeEvents.length===0){assert.equal(current.lifecycleState,before.lifecycleState);return null;}
 assert(ownedDrain,'Owned drain receipt missing');
 assert.equal(modeEvents.length,1,'Another operator mode action occurred');
 assert.deepEqual(modeEvents[0],ownedDrain,'Owned drain audit differs');
 assert.equal(ownedDrain.workerKey,before.workerKey);
 assert.equal(ownedDrain.lifecycleState,'DRAINING');
 assert.equal(ownedDrain.rolloutMode,before.rolloutMode);
 assert.equal(ownedDrain.canarySessionLimit??null,before.canarySessionLimit??null);
 assert.ok(ownedDrain.version>before.version&&ownedDrain.version<=current.version);
 assert.equal(current.lifecycleState,'DRAINING');
 return current.version; // Existing authenticated mode PATCH still enforces CAS.
}
