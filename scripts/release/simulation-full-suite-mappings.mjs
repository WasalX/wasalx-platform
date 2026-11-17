import assert from 'node:assert/strict';
import {applicableAutomationObligations} from './automation-coverage.mjs';

// An unbound selected fixture remains exploratory. Partial release bindings fail
// the existing admission checks; scope alone never records acceptance.
export function simulationEvidenceBound(value){
 return value.scope==='full-suite'||['application','deploymentId','featureMatrix','evidenceSnapshot'].some(key=>value[key]!==undefined);
}

// Scheduling obligations only. Never converts a stage result into context evidence.
export function fullSuiteMappings(catalog,stages,readSource,{selected=false}={}){
 const obligations=applicableAutomationObligations(catalog,readSource);
 const covered=[...new Set(stages.flatMap(s=>s.testIds))];
 if(selected)assert(covered.every(id=>obligations.testIds.includes(id)),'Selected producer contains an inapplicable test');
 else assert.deepEqual(covered.sort(),[...obligations.testIds].sort(),'Full-suite producer coverage incomplete; include PostgreSQL obligations explicitly');
 const byStage=new Map();
 for(const stage of stages){assert(!byStage.has(stage.id),'Duplicate stage');const contexts=stage.contextIds===undefined?null:new Set(stage.contextIds);if(contexts){assert(stage.contextIds.length&&contexts.size===stage.contextIds.length,'Producer contexts must be unique');}const checks=obligations.checks.filter(check=>stage.testIds.includes(check.testId)&&(!contexts||contexts.has(check.contextId)));assert.deepEqual([...new Set(checks.map(check=>check.testId))].sort(),[...stage.testIds].sort(),'Producer context partition omitted a test');byStage.set(stage.id,checks);}
 const key=row=>JSON.stringify([row.testId,row.contextId]);assert.deepEqual([...new Set([...byStage.values()].flat().map(key))].sort(),obligations.checks.filter(row=>covered.includes(row.testId)).map(key).sort(),'Producer context coverage incomplete');
 return{...obligations,byStage};
}
