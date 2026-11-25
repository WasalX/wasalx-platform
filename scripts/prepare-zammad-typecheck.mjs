import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, unlink } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function verifyParents(root, path, allowMissing = false) {
  let parent = root;
  for (const segment of ['', ...path.split('/').slice(0, -1)]) {
    parent = resolve(parent, segment);
    try {
      const stat = await lstat(parent);
      assert(stat.isDirectory(), 'Native fixture parent must be an ordinary directory: ' + relative(root, parent));
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      return;
    }
  }
}

export async function prepareNativeTypecheck({ root, manifest, action, fixtureRoot }) {
  root = resolve(root);
  assert(['restore', 'remove'].includes(action));
  assert(/^[a-f0-9]{40}$/u.test(manifest.revision));
  assert(manifest.files.length > 0 && manifest.files.length <= 128);

  const paths = new Set();
  for (const file of [...manifest.baseFiles, ...manifest.files]) {
    assert(typeof file.path === 'string' && !isAbsolute(file.path) && !/[\\:\0]/u.test(file.path)
      && file.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid native fixture path');
    assert(/^[a-f0-9]{64}$/u.test(file.sha256));
    assert(!paths.has(file.path), 'Duplicate native fixture path: ' + file.path);
    paths.add(file.path);
    const destination = resolve(root, file.path);
    assert(!relative(root, destination).startsWith('..'));
    await verifyParents(root, file.path, true);
  }
  for (const file of manifest.baseFiles) {
    const path = resolve(root, file.path);
    assert((await lstat(path)).isFile());
    assert.equal(sha(await readFile(path)), file.sha256, 'Pinned native base differs: ' + file.path);
  }
  for (const file of manifest.files) {
    assert(file.path.startsWith('app/frontend/'), 'Only frontend typecheck prerequisites may be restored');
  }

  const receipt = resolve(root, '.wasalx-typecheck-fixtures.json');
  const identity = sha(JSON.stringify(manifest));
  if (action === 'remove') {
    const saved = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(saved.manifestSha256, identity);
    // Verify every owned file before deleting any.
    for (const file of manifest.files) {
      const path = resolve(root, file.path);
      assert((await lstat(path)).isFile());
      assert.equal(sha(await readFile(path)), file.sha256, 'Restored fixture changed: ' + file.path);
    }
    for (const file of manifest.files) await unlink(resolve(root, file.path));
    await unlink(receipt);
    return { removed: manifest.files.length };
  }

  assert(fixtureRoot, 'Pinned upstream fixture root is required');
  fixtureRoot = resolve(fixtureRoot);
  await assert.rejects(lstat(receipt), error => error.code === 'ENOENT');
  const fixtures = [];
  for (const file of manifest.files) {
    const destination = resolve(root, file.path);
    await assert.rejects(lstat(destination), error => error.code === 'ENOENT');
    const source = resolve(fixtureRoot, file.path);
    await verifyParents(fixtureRoot, file.path);
    assert((await lstat(source)).isFile(), 'Pinned upstream fixture must be an ordinary file: ' + file.path);
    const bytes = await readFile(source);
    assert.equal(sha(bytes), file.sha256, 'Pinned upstream bytes differ: ' + file.path);
    fixtures.push({ destination, bytes });
  }
  await writeFile(receipt, JSON.stringify({ manifestSha256: identity }), { flag: 'wx', mode: 0o600 });
  for (const { destination, bytes } of fixtures) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
  }
  return { restored: manifest.files.length, upstreamRevision: manifest.revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, root, manifestPath, fixtureRoot] = process.argv.slice(2);
  assert(root && manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  console.log(JSON.stringify(await prepareNativeTypecheck({ action, root, manifest, fixtureRoot })));
}
