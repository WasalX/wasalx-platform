import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { pathToFileURL } from 'node:url';

const LIMIT = 16_384;
const referencePattern = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encode = value => Buffer.from(value).toString('base64');
const nameFor = reference => `wasalx-${createHash('sha256').update(reference).digest('hex')}`;

function validSecret(value) {
  if (!record(value)) return false;
  let keys = 0;
  const visit = (item, depth) => {
    if (depth > 8) return false;
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
    if (record(item)) return Object.entries(item).every(([key, child]) =>
      ++keys <= 128 && !['__proto__', 'constructor', 'prototype'].includes(key) && visit(child, depth + 1));
    return item === null || ['string', 'boolean'].includes(typeof item) || (typeof item === 'number' && Number.isFinite(item));
  };
  return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= LIMIT;
}

async function boundedJson(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('invalid payload');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function sameToken(actual, expected) {
  const left = Buffer.from(actual ?? '');
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

// The transport is injected only for contract tests. Production always uses the
// authenticated HTTPS Kubernetes transport below; no development-store fallback.
export function secretHandler({ namespace, readToken, writeToken, api }) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(namespace)) throw new Error('Invalid namespace');
  for (const token of [readToken, writeToken]) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /\s/u.test(token)) throw new Error('Invalid credential');
  }
  if (readToken === writeToken) throw new Error('Read and write credentials must differ');
  const collection = `/api/v1/namespaces/${namespace}/secrets`;
  return async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      const signal = AbortSignal.timeout(3500);
      const call = (method, path, body) => api(method, path, body, signal);
      if (req.method === 'GET' && req.url === '/health') {
        const probe = await call('GET', `${collection}/wasalx-readiness`);
        return reply([200, 404].includes(probe.status) ? 200 : 503, { status: [200, 404].includes(probe.status) ? 'ok' : 'unavailable' });
      }
      if (req.method !== 'POST' || !['/v1/resolve', '/v1/store', '/v1/delete'].includes(req.url)) return reply(404, { error: 'not_found' });
      const token = req.url === '/v1/resolve' ? readToken : writeToken;
      if (!sameToken(req.headers.authorization, token)) return reply(401, { error: 'unauthorized' });
      let body;
      try { body = await boundedJson(req, LIMIT); } catch { return reply(400, { error: 'invalid_request' }); }
      if (!record(body) || typeof body.reference !== 'string' || Buffer.byteLength(body.reference) > 512 || !referencePattern.test(body.reference)) return reply(400, { error: 'invalid_reference' });
      if (req.url === '/v1/store' && !validSecret(body.value)) return reply(400, { error: 'invalid_secret' });
      const name = nameFor(body.reference);
      const path = `${collection}/${name}`;
      const found = await call('GET', path);
      if (![200, 404].includes(found.status)) return reply(503, { error: 'secret_store_unavailable' });
      if (found.status === 200 && (found.body?.data?.reference !== encode(body.reference) || !found.body?.metadata?.resourceVersion || !found.body?.metadata?.uid)) return reply(503, { error: 'secret_store_unavailable' });
      if (found.status === 200 && found.body.metadata.deletionTimestamp) return reply(503, { error: 'secret_store_unavailable' });
      if (req.url === '/v1/resolve') {
        if (found.status === 404) return reply(404, { error: 'secret_not_found' });
        const encoded = found.body.data.value;
        if (typeof encoded !== 'string' || encoded.length > LIMIT * 2) throw new Error('invalid stored value');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded || bytes.length > LIMIT) throw new Error('invalid stored value');
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!validSecret(value)) throw new Error('invalid stored value');
        return reply(200, value);
      }
      let changed;
      if (req.url === '/v1/delete') {
        if (found.status === 404) return reply(204);
        changed = await call('DELETE', path, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: found.body.metadata.uid, resourceVersion: found.body.metadata.resourceVersion } });
      } else {
        changed = await call(found.status === 404 ? 'POST' : 'PUT', found.status === 404 ? collection : path, {
          apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
          metadata: { name, namespace, ...(found.status === 200 ? { resourceVersion: found.body.metadata.resourceVersion } : {}) },
          data: { reference: encode(body.reference), value: encode(JSON.stringify(body.value)) },
        });
      }
      if ([200, 201, 202, 204].includes(changed.status) || (req.url === '/v1/delete' && changed.status === 404)) {
        if (req.url === '/v1/delete' && (await call('GET', path)).status !== 404) return reply(503, { error: 'secret_store_unavailable' });
        return reply(204);
      }
      // Existing clients retry 503; a Kubernetes resource-version conflict is
      // contention, not a permanently rejected secret write. Never retry here.
      return reply(503, { error: 'secret_store_unavailable' });
    } catch {
      // Kubernetes errors may contain stored data. Never relay or log them.
      if (!res.headersSent) reply(503, { error: 'secret_store_unavailable' });
      else res.destroy();
    }
  };
}

export function kubernetesTransport({ origin, ca, tokenFile }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid Kubernetes origin');
  return async (method, path, body, signal) => {
    // Read the projected token for each request so Kubernetes rotation is honored.
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token || /\s/u.test(token)) throw new Error('Invalid service credential');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const req = request(new URL(path, base), {
        method, ca, signal, minVersion: 'TLSv1.2', rejectUnauthorized: true,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
      }, async res => {
        try {
          // No redirects, retries, or error-body logging. Bound the whole response.
          const parsed = await boundedJson(res, LIMIT * 4);
          resolve({ status: res.statusCode, body: parsed });
        } catch { reject(new Error('Kubernetes request failed')); }
        finally { clearTimeout(deadline); }
      });
      const deadline = setTimeout(() => req.destroy(new Error('Kubernetes timeout')), 4000);
      req.on('error', () => { clearTimeout(deadline); reject(new Error('Kubernetes request failed')); });
      req.end(payload);
    });
  };
}

async function main() {
  const required = name => { if (!process.env[name]) throw new Error('Missing configuration'); return process.env[name]; };
  const [key, cert, ca, readToken, writeToken] = await Promise.all([
    readFile(required('SECRET_TLS_KEY_FILE')), readFile(required('SECRET_TLS_CERT_FILE')),
    readFile(required('KUBERNETES_CA_FILE')), readFile(required('SECRET_READ_TOKEN_FILE'), 'utf8'),
    readFile(required('SECRET_WRITE_TOKEN_FILE'), 'utf8'),
  ]);
  const handler = secretHandler({ namespace: required('SECRET_NAMESPACE'), readToken: readToken.trim(), writeToken: writeToken.trim(), api: kubernetesTransport({ origin: required('KUBERNETES_API_URL'), ca, tokenFile: required('KUBERNETES_TOKEN_FILE') }) });
  const port = Number(process.env.PORT ?? '8443');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const server = createServer({ key, cert, minVersion: 'TLSv1.2', requestTimeout: 6000, headersTimeout: 5000, maxHeaderSize: 8192 }, handler);
  server.on('error', () => { process.stderr.write('Production secret sidecar failed.\n'); process.exitCode = 1; });
  server.listen(port, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  process.stderr.write('Production secret sidecar initialization failed.\n'); process.exitCode = 1;
});
