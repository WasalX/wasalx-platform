import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyInvitationMailerReadiness(s, mailerId) {
 assert.match(mailerId, /^[a-f0-9]{64}$/u);
 const mailer = JSON.parse(await s.run('docker', ['inspect', mailerId]))[0];
 assert.equal(mailer.Id, mailerId);
 assert.equal(mailer.Config.Labels['com.docker.compose.project'], s.model.name);
 assert.equal(mailer.Config.Labels['com.docker.compose.service'], 'invitation-mailer');
 assert.equal(mailer.State.Status, 'running');
 assert.equal(mailer.State.Health?.Status, 'healthy');
 assert.deepEqual(mailer.HostConfig.PortBindings, {});
 const readiness = JSON.parse(await s.run('docker', ['exec', mailerId, 'node', '-e', "const port=Number(process.env.PORT||8085);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid mailer port');fetch('http://127.0.0.1:'+port+'/readyz',{signal:AbortSignal.timeout(15000)}).then(async r=>{const body=await r.json();process.stdout.write(JSON.stringify({status:r.status,providerConnection:body.providerConnection===true}))}).catch(()=>{process.stderr.write('Mailer readiness unavailable\\n');process.exitCode=1})"]));
 assert.equal(readiness.status, 200);
 assert.equal(readiness.providerConnection, true);
 return readiness;
}

export async function invitationMailStage(s, { config }) {
 let step = 'validate';
 try {
  assert(s.model.name.startsWith('wasalx-simulation-'));
  assert(config.recipient && config.sourceSha256);
  step = 'containers';
  const find = async service => {
   const ids = (await s.run('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=' + s.model.name, '--filter', 'label=com.docker.compose.service=' + service])).trim().split(/\s+/).filter(Boolean);
   assert.equal(ids.length, 1);
   return JSON.parse(await s.run('docker', ['inspect', ids[0]]))[0];
  };
  const sink = await find('alpha-smtps'), mailer = await find('invitation-mailer');
  step = 'isolation';
  for (const c of [sink, mailer]) {
   assert.equal(c.Config.Labels['com.docker.compose.project'], s.model.name);
   assert.equal(c.State.Status, 'running');
   assert.equal(c.State.Health?.Status, 'healthy');
   assert.deepEqual(c.HostConfig.PortBindings, {});
   for (const n of Object.keys(c.NetworkSettings.Networks)) assert(JSON.parse(await s.run('docker', ['network', 'inspect', n]))[0].Internal);
  }
  const mount = async (target, c = sink) => {
   const m = c.Mounts.find(x => x.Destination === target);
   assert(m);
   const p = await realpath(m.Source);
   assert(!relative(await realpath(s.privateDir), p).startsWith('..'));
   return p;
  };
  step = 'source';
  const source = await readFile(await mount('/driver/smtp-simulation-server.mjs'));
  assert.equal(createHash('sha256').update(source).digest('hex'), config.sourceSha256);
  step = 'configuration';
  const cfg = JSON.parse(await readFile(await mount('/run/wasalx-simulation/config.json'), 'utf8'));
  const auth = JSON.parse(await readFile(await mount('/run/wasalx-simulation/auth.json'), 'utf8'));
  assert.equal(cfg.isolated, true);
  assert.equal(cfg.port, 465);
  assert(cfg.tls && cfg.authFile);
  assert(cfg.allowedRecipients.includes(config.recipient));
  assert.deepEqual(cfg.faults, []);
  const env = Object.fromEntries(mailer.Config.Env.map(x => { const at = x.indexOf('='); return [x.slice(0, at), x.slice(at + 1)]; }));
  assert.equal(env.INVITATION_EMAIL_PROVIDER_URL, 'smtps://alpha-smtps:465');
  assert.equal(env.INVITATION_EMAIL_FROM, auth.username);
  assert(env.NODE_EXTRA_CA_CERTS);
  await mount(env.NODE_EXTRA_CA_CERTS, mailer);
  const shared = Object.keys(mailer.NetworkSettings.Networks).filter(n => sink.NetworkSettings.Networks[n]);
  assert.equal(shared.length, 1);
  step = 'readiness';
  await verifyInvitationMailerReadiness(s, mailer.Id);
  return { evidenceMode: 'simulated', project: s.model.name, tenantId: s.tenantId, containerId: sink.Id, mailerId: mailer.Id, sender: auth.username, recipientAllowlist: cfg.allowedRecipients, readinessTransport: 'docker-exec-loopback', journalPath: relative(s.privateDir, join(await mount('/state'), 'journal.jsonl')), sourceSha256: config.sourceSha256 };
 } catch (error) {
  if (typeof s.checkpoint === 'function') {
   try {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : null;
    await s.checkpoint({ phase: 'invitation-mail-prerequisite-failed', step, errorClass: error?.name ?? 'Error', errorCode: code, messageSha256: createHash('sha256').update(String(error?.message)).digest('hex') });
   } catch { /* Preserve the original failure. */ }
  }
  throw error;
 }
}
