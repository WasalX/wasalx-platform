import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMetaTemplateMapping, parseMetaTemplateMapping, currentMetaMappedTemplate } from '../packages/core/dist/meta-template-mapping.js';

const flow = '00000000-0000-4000-8000-000000000001';
const dependency = { flowVersionId: flow, name: 'delivery_update', language: 'en_US', parameterCount: 1 };
function inventory(accountId, id, text = 'Your delivery {{1}} is ready.', extra = {}) {
  return { accountId, complete: true, items: [{ id, name: 'delivery_update', language: 'en_US', status: 'APPROVED',
    category: 'UTILITY', parameterFormat: 'POSITIONAL', qualityScore: 'GREEN', definition: {
      id, name: 'delivery_update', language: 'en_US', status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL',
      components: [{ type: 'BODY', text }], ...extra,
    } }] };
}
const source = () => inventory('111', '333');
const target = () => inventory('222', '444');
function input(overrides = {}) { return { source: source(), target: target(), sourceSafetyRevision: 2,
  targetSafetyRevision: 4, dependencies: [dependency], metaFlowDependencyCount: 0, ...overrides }; }

test('semantic mapping pins each immutable flow version and both provider template IDs', () => {
  const proof = buildMetaTemplateMapping(input({ dependencies: [dependency, dependency,
    { ...dependency, flowVersionId: '00000000-0000-4000-8000-000000000002' }] }));
  assert.equal(proof.claim, 'EXACT_TEMPLATE_SEMANTICS');
  assert.equal(proof.mappings.length, 2);
  assert.equal(proof.mappings[0].sourceTemplateId, '333');
  assert.equal(proof.mappings[0].targetTemplateId, '444');
  assert.equal(proof.targetSafetyRevision, 4);
  assert.deepEqual(parseMetaTemplateMapping(proof), proof);
  assert.notEqual(proof.sourceInventorySha256, proof.targetInventorySha256);
});

test('same name and parameter count do not map changed content, language or delivery options', () => {
  for (const destination of [inventory('222', '444', 'Your invoice {{1}} is overdue.'),
    inventory('222', '444', undefined, { message_send_ttl_seconds: 600 })]) {
    assert.equal(buildMetaTemplateMapping(input({ target: destination })), null);
  }
  const language = target(); language.items[0].language = 'ar'; language.items[0].definition.language = 'ar';
  assert.equal(buildMetaTemplateMapping(input({ target: language })), null);
  const rejected = target(); rejected.items[0].status = 'REJECTED';
  assert.equal(buildMetaTemplateMapping(input({ target: rejected })), null);
});

test('unknown definitions, incomplete or duplicate inventory and Meta Flow dependencies never gain a mapping', () => {
  const duplicate = target(); duplicate.items.push(structuredClone(duplicate.items[0]));
  for (const overrides of [{ target: { ...target(), complete: false } }, { target: duplicate },
    { target: inventory('222', '444', undefined, { unknown_send_semantics: true }) },
    { metaFlowDependencyCount: 1 }, { sourceSafetyRevision: -1 }, { targetSafetyRevision: Number.MAX_SAFE_INTEGER + 1 },
    { dependencies: [{ ...dependency, flowVersionId: 'unbound' }] }]) {
    assert.equal(buildMetaTemplateMapping(input(overrides)), null);
  }
});

test('empty dependency mapping requires complete inventories and cannot smuggle unsupported Flow capability', () => {
  const proof = buildMetaTemplateMapping(input({ dependencies: [] }));
  assert.deepEqual(proof.mappings, []);
  assert.equal(buildMetaTemplateMapping(input({ dependencies: [], metaFlowDependencyCount: 1 })), null);
  assert.equal(buildMetaTemplateMapping(input({ dependencies: [], source: { ...source(), complete: false } })), null);
});

test('receipt parser preserves exact historical scope and rejects duplicate or injected authority', () => {
  const proof = buildMetaTemplateMapping(input());
  assert.equal(parseMetaTemplateMapping({ ...proof, canRegister: true }), null);
  assert.equal(parseMetaTemplateMapping({ ...proof, mappings: [...proof.mappings, proof.mappings[0]] }), null);
  assert.equal(parseMetaTemplateMapping({ ...proof, mappings: [{ ...proof.mappings[0], sourceTemplateId: '../other' }] }), null);
  assert.equal(parseMetaTemplateMapping({ ...proof, targetSafetyRevision: '4' }), null);
  assert.equal(parseMetaTemplateMapping({ ...proof, sourceAccountId: proof.targetAccountId }), null);
});

test('UUID case cannot create a duplicate dependency or bypass the historical flow mapping', () => {
  const mixed='aAaAaAaA-bBbB-4CcC-8DdD-eEeEeEeEeEeE';
  const proof=buildMetaTemplateMapping(input({dependencies:[{...dependency,flowVersionId:mixed},
    {...dependency,flowVersionId:mixed.toLowerCase()}]}));
  assert.equal(proof.mappings.length,1);assert.equal(proof.mappings[0].flowVersionId,mixed.toLowerCase());
  assert.equal(parseMetaTemplateMapping({...proof,mappings:[proof.mappings[0],{...proof.mappings[0],flowVersionId:mixed}]}),null);
  assert.deepEqual(currentMetaMappedTemplate({mapping:proof,target:target(),...dependency,flowVersionId:mixed}),proof.mappings[0]);
});

test('current target readback must retain original target ID, semantics and immutable flow identity', () => {
  const mapping=buildMetaTemplateMapping(input()),read=(overrides={})=>currentMetaMappedTemplate({mapping,target:target(),...dependency,...overrides});
  assert.deepEqual(read(),mapping.mappings[0]);
  assert.equal(read({flowVersionId:'00000000-0000-4000-8000-000000000099'}),null);
  assert.equal(read({parameterCount:0}),null);
  assert.equal(read({target:inventory('222','999')}),null,'A recreated same-name template does not inherit the old receipt');
  assert.equal(read({target:inventory('222','444','A different message {{1}}.')}),null);
  assert.equal(read({target:{...target(),complete:false}}),null);
  const duplicate=target();duplicate.items.push(structuredClone(duplicate.items[0]));assert.equal(read({target:duplicate}),null);
  const paused=target();paused.items[0].status='PAUSED';assert.equal(read({target:paused}),null);
  assert.equal(read({target:inventory('111','444')}),null,'Original source account never becomes current target evidence');
});
