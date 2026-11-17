import assert from 'node:assert/strict';import test from 'node:test';
import {RuleTestService} from '../services/control-api/dist/rule-test.service.js';
test('excluded team preview explains policy without inventing matches',()=>{
 const service=new RuleTestService(),rule={id:'r',name:'Ten digits',matcherType:'exact_length',pattern:'(?<!\\d)\\d{10}(?!\\d)',digitLength:10,priority:10,enabled:true,teamSenderPolicy:'exclude'};
 const team=service.evaluate({message:'1234567890',rules:[rule],sender:'team'});assert.equal(team.matches.length,0);assert.deepEqual(team.warnings.filter(w=>w.code==='TEAM_SENDER_EXCLUDED').map(w=>w.ruleIds),[['r']]);
 const unknown=service.evaluate({message:'1234567890',rules:[rule],sender:'unknown'});assert.equal(unknown.matches.length,0);assert.deepEqual(unknown.warnings.filter(w=>w.code==='TEAM_SENDER_EXCLUDED').map(w=>w.ruleIds),[['r']]);
 const customer=service.evaluate({message:'1234567890',rules:[rule],sender:'customer'});assert(!customer.warnings.some(w=>w.code==='TEAM_SENDER_EXCLUDED'));
});
