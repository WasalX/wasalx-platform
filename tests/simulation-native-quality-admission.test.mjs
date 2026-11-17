import test from'node:test';import assert from'node:assert/strict';import{admitNativeQualityDefinitions}from'../scripts/release/simulation-native-quality-admission.mjs';
const defs=()=>['loading','safe-error-recovery','reload','keyboard-focus','console','network','empty','degraded'].map(x=>({id:'team-access/team-group-grants-independent-from-ticket-ownership::ui-quality::'+x}));
test('granted native8 accepted',()=>assert.equal(admitNativeQualityDefinitions(defs()).length,1));
test('missing obligation denied',()=>assert.throws(()=>admitNativeQualityDefinitions(defs().slice(1))));
test('duplicate obligation denied',()=>{const d=defs();d[0]=d[1];assert.throws(()=>admitNativeQualityDefinitions(d))});
test('reviewed privacy reader and grants share complete native obligations',()=>{const privacy=defs().map(x=>({id:x.id.replace('team-access/team-group-grants-independent-from-ticket-ownership','privacy-retention/media-and-history-authorization-boundaries')}));assert.equal(admitNativeQualityDefinitions([...defs(),...privacy]).length,2)});
test('unrelated surface remains denied',()=>assert.throws(()=>admitNativeQualityDefinitions(defs().map(x=>({id:x.id.replace('team-access/team-group-grants-independent-from-ticket-ownership','unknown-surface')})))));
