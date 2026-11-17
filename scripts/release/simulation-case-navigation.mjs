// PROPOSAL ONLY. Main must apply with the reviewed manifest and actual-baseline transition.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {parseRailsJson} from './simulation-rails-json.mjs';
import {nativeLinkTestId} from './simulation-native-account-linking.mjs';
import {ensurePortalOperator,capturePortalOperatorEvidence,bindPortalOperatorResult} from './simulation-portal-operator.mjs';
export const caseNavigationId = 'cases-deliveries/exact-case-lookup-and-direct-agent-navigation::exact-case-opens-the-authorized-agent-destination::02';
const contexts = [
  {id:'tenant_owner-en-desktop', role:'tenant_owner', viewport:'desktop', width:1440, height:1000},
  {id:'agent-en-desktop', role:'agent', viewport:'desktop', width:1440, height:1000},
  {id:'agent-en-tablet', role:'agent', viewport:'tablet', width:820, height:1180},
  {id:'agent-en-mobile', role:'agent', viewport:'mobile', width:390, height:844},
];
const digest = value => 'sha256:' + createHash('sha256').update(String(value)).digest('hex');
export function assertPortalCaseRedirect(status, location, origin, number) {
  assert.equal(status, 303);
  assert.equal(typeof number, 'string');
  assert.match(number, /^[0-9]{1,32}$/u);
  const url = new URL(location);
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, '/app');
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.entries()].sort(), [['ticket', number], ['view', 'inbox']]);
  return url.href;
}
// Historical helper only; no active stage produces native-browser qualification.
export function assertCaseRedirect(status, location, origin, id, view) {
  assert.equal(status, 303); const url = new URL(location);
  assert.equal(url.origin, origin); assert.equal(url.pathname, '/' + view + '/tickets/' + id); return url.href;
}
export async function caseNavigationStage(s, {namespace, inputs}) {
  const startedAt = new Date().toISOString(), proofs = [];
  const finish = async () => {
    for (const row of proofs) await s.checkpoint({phase:'case-navigation-proof', ...row});
    return {evidenceMode:'simulated', namespace, tenantId:s.tenantId, startedAt, finishedAt:new Date().toISOString(), proofs};
  };
  let group, correlation, agent, foreign, ownerDetail, requestFor,ownerOperator,agentOperator;
  try {
    assert.equal(inputs.nativeAccountAccess.namespace, namespace);
    assert.equal(inputs.nativeAccountAccess.tenantId, s.tenantId);
    assert(inputs.nativeAccountAccess.results.some(row => row.testId === nativeLinkTestId && row.result === 'passed'),
      'Reviewed native-account linking/continuation receipt required');
    group = inputs.remainingQuality.caseLifecycle.group;
    assert.equal(group.namespace, namespace); assert.equal(group.tenantId, s.tenantId);
    agent = s.capabilities.secondActor; foreign = s.capabilities.isolationActor;
    assert.equal(agent.userId, inputs.secondActor.userId); assert.equal(agent.subject, inputs.secondActor.subject);
    assert.equal(inputs.secondActor.tenantId, s.tenantId);
    assert.equal(foreign.userId, inputs.securityBusiness.isolationActor.userId);
    assert.notEqual(inputs.securityBusiness.isolationActor.tenantId, s.tenantId);
    await s.verifyOwner(s.ownerPage, s.ownerId, 'tenant_owner', s.tenantId);
    await s.verifyOwner(agent.page, agent.userId, 'agent', s.tenantId);
    await s.verifyOwner(foreign.page, foreign.userId, 'tenant_owner', inputs.securityBusiness.isolationActor.tenantId);
    ownerOperator=await ensurePortalOperator(s,{role:'tenant_owner'});
    agentOperator=await ensurePortalOperator(s,{role:'agent'});
    const installed = parseRailsJson(await s.run('docker', ['exec', s.containers['zammad-railsserver'].Id,
      'bundle', 'exec', 'rails', 'runner', "require 'json';puts JSON.generate(Wasalx::InstalledPackage.verify!)"]));
    assert.equal(installed.candidate_commit_sha, s.candidate.sha);
    assert.equal(installed.candidate_tree_sha, s.candidate.tree);
    const cases = await s.scoped(`SELECT id,zammad_ticket_id,zammad_ticket_number,normalized_reference
      FROM case_correlations WHERE tenant_id=$1 AND group_binding_id=$2 AND zammad_ticket_id=$3`,
      [s.tenantId, group.bindingId, String(group.ticketId)]);
    assert.equal(cases.length, 1); correlation = cases[0];
    assert.match(correlation.zammad_ticket_number, /^[0-9]{1,32}$/u);
    requestFor = page => createSyntheticRequest({page, origin:s.portalOrigin, runId:namespace, checkpoint:s.checkpoint});
    for (const page of [s.ownerPage, agent.page]) {
      const request = requestFor(page);
      assert.equal((await request('/api/inbox', 'POST', {operation:'CHECK', input:{}})).allowed, true);
      const detail = await request('/api/inbox', 'POST', {operation:'SHOW', input:{ticket_id:correlation.zammad_ticket_id}});
      assert.equal(detail.id, correlation.zammad_ticket_id); assert.equal(detail.number, correlation.zammad_ticket_number);
      assert.equal(typeof detail.title, 'string'); assert(detail.title.length);
      if (!ownerDetail) ownerDetail = detail; else assert.equal(detail.title, ownerDetail.title);
    }
  } catch (error) {
    for (const context of contexts) proofs.push({testId:caseNavigationId, contextId:context.id, result:'blocked', startedAt,
      finishedAt:new Date().toISOString(), proof:{classification:'prerequisite-blocked',
        nextAction:'Admit reviewed linking/continuation, current managed projection and exact ticket grants; reconcile ledger context migration.',
        errorClass:error.name, messageSha256:digest(error.message)}});
    return finish();
  }
  const get = async (page, path) => {
    const response = await page.request.get(s.portalOrigin + path, {maxRedirects:0});
    return {status:response.status(), headers:response.headers(), text:await response.text()};
  };
  const missingId = randomUUID();
  assert.equal((await s.scoped('SELECT id FROM case_correlations WHERE id=$1', [missingId])).length, 0);
  const exact = await requestFor(s.ownerPage)('/api/cases?ticket=' + encodeURIComponent(correlation.zammad_ticket_number));
  assert.equal(exact.length, 1); assert.equal(exact[0].id, correlation.id);
  assert.deepEqual(await requestFor(foreign.page)('/api/cases?ticket=' + encodeURIComponent(correlation.zammad_ticket_number)), []);
  for (const [page, id] of [[s.ownerPage, missingId], [foreign.page, correlation.id]]) {
    const denied = await get(page, '/api/cases/' + id + '/open'); assert([403,404].includes(denied.status));
    for (const secret of [correlation.id, correlation.zammad_ticket_number, correlation.normalized_reference])
      assert(!denied.text.includes(secret));
  }
  const response = await get(s.ownerPage, '/api/cases/' + correlation.id + '/open');
  const destination = assertPortalCaseRedirect(response.status, response.headers.location, s.portalOrigin, correlation.zammad_ticket_number);
  for (const context of contexts) {
    const page = context.role === 'agent' ? agent.page : s.ownerPage;
    const userId = context.role === 'agent' ? agent.userId : s.ownerId;
    let result = 'passed', proof;
    try {
      await s.verifyOwner(page, userId, context.role, s.tenantId);
      await page.setViewportSize({width:context.width, height:context.height});
      assert(/^en(?:[-_]|$)/iu.test(await page.evaluate(() => document.documentElement.lang)));
      if (context.role === 'tenant_owner') {
        await page.goto(s.portalOrigin + '/app?view=cases&ticket=' + encodeURIComponent(correlation.zammad_ticket_number));
        await page.getByRole('button', {name:'Open support case #' + correlation.zammad_ticket_number + ' in the agent workspace', exact:true}).click();
      } else await page.goto(destination);
      await page.waitForURL(url => url.origin === s.portalOrigin && url.pathname === '/app' &&
        url.searchParams.get('view') === 'inbox' && url.searchParams.get('ticket') === correlation.zammad_ticket_number);
      await page.getByRole('heading', {name:ownerDetail.title, exact:true}).waitFor({state:'visible'});
      const request = requestFor(page);
      assert.equal((await request('/api/inbox', 'POST', {operation:'CHECK', input:{}})).allowed, true);
      const current = await request('/api/inbox', 'POST', {operation:'SHOW', input:{ticket_id:correlation.zammad_ticket_id}});
      assert.equal(current.number, correlation.zammad_ticket_number); assert.equal(current.title, ownerDetail.title);
      await s.verifyOwner(page, userId, context.role, s.tenantId);
      const binding = await capturePortalOperatorEvidence(context.role==='agent'?agentOperator:ownerOperator);
      proof = {caseId:correlation.id, friendlyNumber:correlation.zammad_ticket_number, backendTicketId:correlation.zammad_ticket_id,
        actorVerified:true, exactPortalLookup:true, missingDenied:true, foreignDenied:true, nativeUiUsed:false, binding};
    } catch (error) {
      result = 'failed'; proof = {classification:'requires-review', errorClass:error.name, messageSha256:digest(error.message)};
    }
    const row={testId:caseNavigationId, contextId:context.id, result, startedAt, finishedAt:new Date().toISOString(),
      context:{role:context.role, locale:'en', viewport:context.viewport, surface:'portal'},
      ...(proof.binding ? {actorRef:proof.binding.actorRef, tenantRef:proof.binding.tenantRef,
        actualViewport:proof.binding.viewport, verifiedContext:proof.binding} : {}), proof};
    proofs.push(proof.binding?bindPortalOperatorResult(row,proof.binding,{testIds:[caseNavigationId]}):row);
  }
  return finish();
}
