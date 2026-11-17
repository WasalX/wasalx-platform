import assert from 'node:assert/strict';
export const isolationPrefix='tenant-provisioning/secrets-database-search-storage-and-workspace-isolation::cross-workspace-resources-remain-unavailable::';
export const teamPrefix='team-access/roles-invitations-revocation-and-last-owner-protection::';
export const securityTestIds=[...['01','02','03','detail-1','detail-2','detail-3','detail-4'].map(x=>isolationPrefix+x),...['unauthorized','cross-tenant'].map(x=>teamPrefix+'tenant-team-whatsapp-identity-is-managed-and-audited::'+x),teamPrefix+'multiple-team-whatsapp-numbers::isolation-stale'];
export function admitSecurityFixture(s,{namespace,inputs}){
 assert.match(namespace,/^[A-Za-z0-9-]{1,40}$/);assert(s.model.name.startsWith('wasalx-simulation-'));assert(s.actorBinding?.userMatched&&s.actorBinding?.workspaceMatched);
 const group=inputs.group,other=inputs.isolationActor,agent=inputs.secondActor;
 for(const item of [group,other,agent]){assert.equal(item?.namespace,namespace);assert.equal(item.evidenceMode,'simulated')}
 assert.equal(group.tenantId,s.tenantId);assert.equal(agent.tenantId,s.tenantId);assert.notEqual(other.tenantId,s.tenantId);assert.notEqual(other.userId,s.ownerId);assert.notEqual(other.userId,agent.userId);
 assert.equal(other.project,s.model.name);assert.equal(other.role,'tenant_owner');assert.equal(other.onlyIsolationMembership,true);
 for(const [name,input]of [['secondActor',agent],['isolationActor',other]]){const c=s.capabilities[name];assert(c?.page);assert.equal(c.userId,input.userId);assert.equal(c.memberId,input.memberId)}
 assert(group.connectionId);return {group,other,agent};
}
