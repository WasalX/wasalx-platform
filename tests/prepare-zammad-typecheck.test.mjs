import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareNativeTypecheck } from '../scripts/prepare-zammad-typecheck.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixturePath = 'app/frontend/tests/helper.ts';
const receipt = '.wasalx-typecheck-fixtures.json';
const fixtureBytes = 'exact upstream helper';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'native-typecheck-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'native');
  const fixtureRoot = join(directory, 'pinned');
  await mkdir(root);
  await mkdir(join(fixtureRoot, 'app/frontend/tests'), { recursive: true });
  await writeFile(join(root, 'package.json'), 'base');
  await writeFile(join(fixtureRoot, fixturePath), fixtureBytes);
  const manifest = {
    revision: 'a'.repeat(40),
    baseFiles: [{ path: 'package.json', sha256: hash('base') }],
    files: [{ path: fixturePath, sha256: hash(fixtureBytes) }],
  };
  return { root, manifest, fixtureRoot };
}

test('restores exact pinned prerequisites and removes only the owned bytes', async t => {
  const f = await fixture(t);
  assert.deepEqual(await prepareNativeTypecheck({ ...f, action: 'restore' }), {
    restored: 1, upstreamRevision: f.manifest.revision,
  });
  assert.equal(await readFile(join(f.root, fixturePath), 'utf8'), fixtureBytes);
  await writeFile(join(f.root, 'unrelated.txt'), 'keep');
  assert.deepEqual(await prepareNativeTypecheck({ root: f.root, manifest: f.manifest, action: 'remove' }), { removed: 1 });
  await assert.rejects(readFile(join(f.root, fixturePath)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.root, receipt)), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.root, 'unrelated.txt'), 'utf8'), 'keep');
});

test('base mismatch rejects before reading upstream fixtures', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'package.json'), 'changed');
  await rm(join(f.fixtureRoot, fixturePath));
  await assert.rejects(prepareNativeTypecheck({ ...f, action: 'restore' }), /Pinned native base differs/u);
});

test('an invalid later fixture leaves no receipt or restored files', async t => {
  const f = await fixture(t);
  const other = 'app/frontend/tests/other.ts';
  f.manifest.files.push({ path: other, sha256: hash('expected') });
  await writeFile(join(f.fixtureRoot, other), 'wrong');
  await assert.rejects(prepareNativeTypecheck({ ...f, action: 'restore' }), /Pinned upstream bytes differ/u);
  await assert.rejects(readFile(join(f.root, receipt)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.root, fixturePath)), { code: 'ENOENT' });
});

test('rejects a symlinked upstream parent even when the file bytes match', async t => {
  const f = await fixture(t);
  const source = join(f.fixtureRoot, 'app');
  const outside = join(f.fixtureRoot, '..', 'outside');
  await rename(source, outside);
  await symlink(outside, source, 'junction');
  await assert.rejects(prepareNativeTypecheck({ ...f, action: 'restore' }), /ordinary directory/u);
  await assert.rejects(readFile(join(f.root, receipt)), { code: 'ENOENT' });
});

test('changed owned source prevents cleanup and preserves receipt', async t => {
  const f = await fixture(t);
  await prepareNativeTypecheck({ ...f, action: 'restore' });
  await writeFile(join(f.root, fixturePath), 'changed');
  await assert.rejects(prepareNativeTypecheck({ ...f, action: 'remove' }), /Restored fixture changed/u);
  assert.equal(await readFile(join(f.root, fixturePath), 'utf8'), 'changed');
  assert(await readFile(join(f.root, receipt)));
});
