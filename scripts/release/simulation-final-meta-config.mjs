import assert from 'node:assert/strict';
export function assertFinalMetaConfig(setup){
 assert(/^[A-Za-z0-9-]{1,30}$/.test(setup.namespace),'Final Meta stages require namespace <=30');
 const m=setup.meta;assert(m&&m.pinned&&m.terminal&&m.safeRetry);
 const phone=x=>typeof x==='string'&&/^[1-9][0-9]{6,14}$/.test(x);
 assert(phone(m.customer)&&phone(m.choiceCustomer)&&m.customer!==m.choiceCustomer);
 assert(Array.isArray(m.pinned.recipients)&&m.pinned.recipients.length===2);
 assert(Array.isArray(m.terminal.recipients)&&m.terminal.recipients.length===3);
 const all=[m.customer,m.choiceCustomer,...m.pinned.recipients,...m.terminal.recipients,m.safeRetry.recipient];
 assert(all.every(phone)&&new Set(all).size===8,'Each new Meta recipient must be distinct from earlier text/choice recipients');
 const asset=a=>{assert(a&&typeof a.path==='string'&&a.path.length&&!a.path.startsWith('/')&&!/^[A-Za-z]:/.test(a.path)&&!a.path.split(/[\\/]/).includes('..'));assert(/^[a-f0-9]{64}$/.test(a.sha256));};
 assert(Array.isArray(m.pinned.assets)&&m.pinned.assets.length===2);m.pinned.assets.forEach(asset);assert.notEqual(m.pinned.assets[0].sha256,m.pinned.assets[1].sha256);asset(m.safeRetry.asset);
 return{recipients:all.slice(2),assets:[...m.pinned.assets,m.safeRetry.asset]};
}
