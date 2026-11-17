import {mkdtemp,writeFile,readFile,rm,chmod} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../../package.json',import.meta.url));
export const adapterUrl=new URL('../../services/connector-worker/dist/packages/connectors/src/meta.js',import.meta.url).href;
export const undiciUrl=pathToFileURL(createRequire(createRequire(require.resolve('wrangler/package.json')).resolve('miniflare')).resolve('undici')).href;
// Same ephemeral OpenSSL CA/server pattern as smtp-simulation-tls.test.mjs.
export async function testTls() {
  if (process.platform === 'win32') return {};
  const dir = await mkdtemp(join(tmpdir(), 'wasalx-meta-tls-'));
  try {
    await chmod(dir, 0o700);
    const run = promisify(execFile);
    await writeFile(join(dir, 'openssl.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
    const ssl = (...args) => run('openssl', args, {
      timeout: 15000, env: { ...process.env, OPENSSL_CONF: join(dir, 'openssl.cnf') },
    });
    await ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Meta Synthetic CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'), '-days', '1');
    await ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=graph.facebook.com',
      '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.csr'));
    await writeFile(join(dir, 'ext.cnf'), 'subjectAltName=DNS:graph.facebook.com\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n');
    await ssl('x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'),
      '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'server.crt'), '-days', '1',
      '-extfile', join(dir, 'ext.cnf'));
    const tls = {
      key: await readFile(join(dir, 'server.key')),
      cert: await readFile(join(dir, 'server.crt')),
      ca: await readFile(join(dir, 'ca.crt')),
    };
    return tls;
  } finally {
    // Callers retain only buffers; setup owns and removes its files on every outcome.
    await rm(dir, { recursive: true, force: true });
  }
}
