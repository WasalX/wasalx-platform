import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { secretHandler, kubernetesTransport } from '../tools/production-secret-sidecar.mjs';

test('secret contract preserves durable values and separates reader/writer authority', async t => {
  const readToken = 'r'.repeat(40), writeToken = 'w'.repeat(40);
  const records = new Map();
  let conflict = false, unavailable = false, pendingDeletion = false, version = 0;
  const signals = [];
  const api = async (method, path, body, signal) => {
    assert.ok(signal instanceof AbortSignal);
    signals.push(signal);
    if (unavailable) return { status: 403, body: { message: 'sensitive backend details' } };
    if (method === 'GET') return records.has(path) ? { status: 200, body: structuredClone(records.get(path)) } : { status: 404 };
    if (conflict) return { status: 409 };
    if (method === 'DELETE') {
      assert.deepEqual(body.preconditions, { uid: 'test-uid', resourceVersion: records.get(path).metadata.resourceVersion });
      if (pendingDeletion) { records.get(path).metadata.deletionTimestamp = '2026-09-11T00:00:00Z'; return { status: 202 }; }
      records.delete(path); return { status: 200 };
    }
    if (method === 'PUT') assert.equal(body.metadata.resourceVersion, records.get(path).metadata.resourceVersion);
    const key = method === 'POST' ? `${path}/${body.metadata.name}` : path;
    records.set(key, { ...body, metadata: { ...body.metadata, uid: 'test-uid', resourceVersion: String(++version) } });
    return { status: method === 'POST' ? 201 : 200 };
  };
  let server;
  async function start() {
    server = createServer(secretHandler({ namespace: 'wasalx-secrets', readToken, writeToken, api }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  }
  await start();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = async (route, token, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const reference = 'secret://tenants/example/mail';
  const value = { privateKeyPem: 'test-key\nmultiline', keyVersion: '1' };
  assert.equal((await call('/v1/store', readToken, { reference, value })).status, 401);
  assert.equal((await call('/v1/resolve', writeToken, { reference })).status, 401);
  assert.equal((await call('/v1/store', writeToken, { reference, value })).status, 204);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await start(); // The adapter owns no in-memory secret store.
  const resolved = await call('/v1/resolve', readToken, { reference });
  assert.equal(resolved.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await resolved.json(), value);
  assert.equal((await call('/v1/store', writeToken, { reference, value: { token: 'updated' } })).status, 204);
  conflict = true;
  assert.equal((await call('/v1/delete', writeToken, { reference })).status, 503);
  assert.equal(records.size, 1);
  conflict = false;
  pendingDeletion = true;
  signals.length = 0;
  assert.equal((await call('/v1/delete', writeToken, { reference })).status, 503);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal === signals[0]));
  assert.equal((await call('/v1/resolve', readToken, { reference })).status, 503);
  assert.equal((await call('/v1/store', writeToken, { reference, value })).status, 503);
  pendingDeletion = false;
  delete [...records.values()][0].metadata.deletionTimestamp;
  assert.equal((await call('/v1/delete', writeToken, { reference })).status, 204);
  assert.equal((await call('/v1/delete', writeToken, { reference })).status, 204);
  assert.equal((await call('/v1/resolve', readToken, { reference })).status, 404);
  assert.equal((await call('/v1/store', writeToken, { reference: '../../escape', value })).status, 400);
  assert.equal((await call('/v1/store', writeToken, { reference, value: JSON.parse('{"__proto__":{}}') })).status, 400);
  assert.equal((await call('/v1/store', writeToken, { reference, value })).status, 204);
  const stored = [...records.values()][0];
  stored.data.reference = Buffer.from('secret://another/tenant').toString('base64');
  assert.equal((await call('/v1/resolve', readToken, { reference })).status, 503);
  unavailable = true;
  const failed = await call('/v1/resolve', readToken, { reference });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'secret_store_unavailable' });
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/health`)).status, 503);
});

test('real HTTPS transport validates certificates, rotates tokens, bounds replies and aborts stalled requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasalx-secret-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certPath = join(directory, 'cert.pem'), keyPath = join(directory, 'key.pem'), tokenFile = join(directory, 'token');
  const bundled = 'C:/Program Files/Git/usr/bin/openssl.exe';
  const openssl = process.platform === 'win32' && existsSync(bundled) ? bundled : 'openssl';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  let expectedToken = 'first-test-token';
  let hits = 0;
  const server = createHttpsServer({ cert, key }, (req, res) => {
    hits++;
    if (req.headers.authorization !== `Bearer ${expectedToken}`) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/stalled') return;
    if (req.url === '/oversized') { res.end(JSON.stringify({ value: 'x'.repeat(70_000) })); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/must-not-follow' }); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `https://127.0.0.1:${server.address().port}`;
  await writeFile(tokenFile, expectedToken, { mode: 0o600 });
  const api = kubernetesTransport({ origin, ca: cert, tokenFile });
  assert.deepEqual(await api('GET', '/ok', undefined, AbortSignal.timeout(1000)), { status: 200, body: { ok: true } });
  expectedToken = 'rotated-test-token';
  await writeFile(tokenFile, expectedToken);
  assert.equal((await api('GET', '/ok', undefined, AbortSignal.timeout(1000))).status, 200);
  const before = hits;
  assert.equal((await api('GET', '/redirect', undefined, AbortSignal.timeout(1000))).status, 302);
  assert.equal(hits, before + 1);
  const untrusted = kubernetesTransport({ origin, tokenFile });
  await assert.rejects(untrusted('GET', '/ok', undefined, AbortSignal.timeout(1000)), /Kubernetes request failed/);
  await assert.rejects(api('GET', '/oversized', undefined, AbortSignal.timeout(1000)), /Kubernetes request failed/);
  const started = performance.now();
  await assert.rejects(api('GET', '/stalled', undefined, AbortSignal.timeout(100)), /Kubernetes request failed/);
  assert.ok(performance.now() - started < 2000, 'shared abort must end the request before the transport fallback timeout');
});

test('production setup rejects shared credentials, invalid namespaces and insecure API origins', () => {
  const config = { namespace: 'wasalx-secrets', readToken: 'r'.repeat(40), writeToken: 'w'.repeat(40), api: async () => ({ status: 404 }) };
  assert.throws(() => secretHandler({ ...config, writeToken: config.readToken }));
  assert.throws(() => secretHandler({ ...config, namespace: '../default' }));
  assert.throws(() => secretHandler({ ...config, readToken: 'short' }));
  for (const origin of ['http://kubernetes/', 'https://user:password@kubernetes/', 'https://kubernetes/path', 'https://kubernetes/?token=x']) {
    assert.throws(() => kubernetesTransport({ origin }));
  }
});
