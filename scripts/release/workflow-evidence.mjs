import {requiredOperatorInput} from "./operator-input.mjs";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = /^[a-f0-9]{40}$/u;
export const evidenceRepository = 'WasalX/WasalX';
export const evidenceRepositoryId = 0;

// Read-only Actions/contents access. Never accept a pod-supplied API host or receipt.
export function githubEvidenceApi(repository, path) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/u);
  assert.ok(process.env.GH_TOKEN || process.env.GITHUB_TOKEN, 'UNVERIFIED: GitHub read token is required');
  try {
    return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '-H', 'X-GitHub-Api-Version: 2022-11-28', '--paginate', '--slurp',
      `repos/${repository}/${path}`], { encoding: 'utf8', timeout: 30_000, maxBuffer: 20 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    throw new Error('UNVERIFIED: GitHub evidence lookup failed');
  }
}

const gitTree = revision => execFileSync('git', ['rev-parse', '--verify', `${revision}^{tree}`],
  { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function lookupWorkflowEvidence({ repository, runId, runAttempt, headSha, workflowPath, events, refs,
  candidateTree, allowInProgress = false }, { api = githubEvidenceApi, treeFor = gitTree } = {}) {
  try {
    assert.equal(repository, evidenceRepository, 'unexpected evidence repository');
    assert.ok(positive(runId) && positive(runAttempt) && sha.test(headSha));
    assert.ok(Array.isArray(events) && events.length && Array.isArray(refs) && refs.length);
    const one = path => {
      const pages = api(repository, path);
      assert.equal(pages.length, 1, 'ambiguous GitHub identity');
      return pages[0];
    };
    const current = one(`actions/runs/${runId}`);
    const run = one(`actions/runs/${runId}/attempts/${runAttempt}`);
    assert.equal(current.event, run.event);
    assert.equal(current.head_branch, run.head_branch);
    for (const record of [current, run]) {
      assert.equal(record.id, runId);
      assert.equal(record.run_attempt, runAttempt, 'superseded workflow attempt');
      assert.equal(record.repository?.full_name, repository);
      assert.equal(record.repository?.id, evidenceRepositoryId);
      assert.equal(record.head_repository?.full_name, repository);
      assert.equal(record.head_repository?.id, evidenceRepositoryId);
      assert.equal(record.path, workflowPath);
      assert.equal(record.head_sha, headSha);
      assert.ok(events.includes(record.event), 'workflow event differs');
      assert.ok(refs.some(ref => ref === `refs/heads/${record.head_branch}`
        || (record.event === 'push' && ref === `refs/tags/${record.head_branch}`)), 'workflow ref differs');
      assert.ok((record.status === 'completed' && record.conclusion === 'success')
        || (allowInProgress && record.status === 'in_progress' && record.conclusion === null), 'workflow is not successful');
    }
    const commit = one(`git/commits/${headSha}`);
    assert.equal(commit.sha, headSha);
    const tree = treeFor(headSha);
    assert.ok(sha.test(tree));
    assert.equal(commit.tree?.sha, tree, 'GitHub/Git tree differs');
    if (candidateTree !== undefined) assert.equal(tree, candidateTree, 'candidate tree differs');
    const pages = api(repository, `actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`);
    assert.ok(pages.length && pages.every(page => Array.isArray(page.jobs)));
    return { repository, run, jobs: pages.flatMap(page => page.jobs), tree };
  } catch {
    throw new Error('UNVERIFIED: workflow run, attempt, source or conclusion could not be verified');
  }
}

export function verifiedWorkflowJob(evidence, name, { id, conclusion = 'success' } = {}) {
  const matches = evidence.jobs.filter(job => job.name === name);
  assert.equal(matches.length, 1, `UNVERIFIED: missing or ambiguous GitHub job: ${name}`);
  const job = matches[0], run = evidence.run;
  assert.ok(positive(job.id) && (id === undefined || job.id === id)
    && job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === run.head_sha
    && job.status === 'completed' && job.conclusion === conclusion
    && job.html_url === `https://github.com/${evidence.repository}/actions/runs/${run.id}/job/${job.id}`,
  `UNVERIFIED: GitHub job identity or conclusion differs: ${name}`);
  return job;
}

export function currentWorkflowRun(environment = process.env) {
  return { id: Number(environment.GITHUB_RUN_ID), attempt: Number(environment.GITHUB_RUN_ATTEMPT),
    workflowRef: environment.GITHUB_WORKFLOW_REF, headSha: environment.GITHUB_SHA };
}

function downloadWorkflowArtifact(repository, id) {
  assert.ok(process.env.GH_TOKEN || process.env.GITHUB_TOKEN, 'UNVERIFIED: GitHub read token is required');
  try {
    return execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '-H', 'X-GitHub-Api-Version: 2022-11-28', `repos/${repository}/actions/artifacts/${id}/zip`],
    { timeout: 30_000, maxBuffer: 536_870_912, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('UNVERIFIED: GitHub artifact download failed'); }
}

export function readWorkflowArtifactMembers(bytes, members, release = false) {
  const directory = mkdtempSync(join(tmpdir(), 'wasalx-workflow-artifact-'));
  try {
    const archive = join(directory, 'artifact.zip');
    writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
    const program = `import base64,io,json,sys,tarfile,zipfile
z=zipfile.ZipFile(sys.argv[1])
names=json.loads(sys.argv[2])
if sys.argv[3]=='release':
 items=[i for i in z.infolist() if i.filename=='wasalx-release-evidence.tar.gz']
 assert len(items)==1 and 0<items[0].file_size<=536870912
 t=tarfile.open(fileobj=io.BytesIO(z.read(items[0])),mode='r:gz')
 entries=t.getmembers()
 assert len(entries)<=500 and sum(i.size for i in entries)<=536870912
 def read(name):
  items=[i for i in entries if i.name in [name,'./'+name]]
  assert len(items)==1 and items[0].isfile() and 0<items[0].size<=262144
  return t.extractfile(items[0]).read()
else:
 def read(name):
  items=[i for i in z.infolist() if i.filename==name]
  assert len(items)==1 and 0<items[0].file_size<=262144
  return z.read(items[0])
print(json.dumps([base64.b64encode(read(name)).decode('ascii') for name in names]))`;
    return JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-I', '-c', program, archive, JSON.stringify(members), release ? 'release' : 'direct'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 2_097_152, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))
      .map(value => Buffer.from(value, 'base64'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function verifyWorkflowArtifact(evidence, job, manifest, members, publishing, dependencies = {}) {
  try {
    const { api = githubEvidenceApi, downloadArtifact = downloadWorkflowArtifact } = dependencies;
    const run = evidence.run;
    const name = publishing ? `wasalx-release-${run.id}-${run.run_attempt}-aggregate`
      : `wasalx-zammad-compat-${run.id}-${run.run_attempt}`;
    const matches = api(evidence.repository, `actions/runs/${run.id}/artifacts?per_page=100`)
      .flatMap(page => page.artifacts).filter(artifact => artifact.name === name);
    assert.equal(matches.length, 1, 'duplicate or missing workflow artifact');
    const artifact = matches[0], created = Date.parse(artifact.created_at);
    assert.ok(positive(artifact.id) && artifact.expired === false && positive(artifact.size_in_bytes)
      && artifact.size_in_bytes <= 536_870_912 && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest));
    assert.ok(Number.isFinite(created) && created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at),
      'artifact is outside the successful producer interval');
    if (artifact.workflow_run !== undefined) {
      assert.equal(artifact.workflow_run.id, run.id);
      assert.equal(artifact.workflow_run.head_sha, run.head_sha);
      if (artifact.workflow_run.run_attempt !== undefined) assert.equal(artifact.workflow_run.run_attempt, run.run_attempt);
    }
    assert.ok(members.length && members.every(member => Buffer.isBuffer(member.bytes)));
    const bytes = downloadArtifact(evidence.repository, artifact.id);
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 536_870_912);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.digest, 'artifact archive digest differs');
    const actual = readWorkflowArtifactMembers(bytes, members.map(member => member.path), publishing);
    for (let index = 0; index < members.length; index++) assert.ok(actual[index].equals(members[index].bytes), 'workflow manifest bytes differ');
    assert.deepEqual(JSON.parse(members.find(member => member.path.endsWith(`${manifest.gate}.json`)).bytes), manifest);
    return { id: artifact.id, digest: artifact.digest };
  } catch { throw new Error('UNVERIFIED: workflow artifact identity, interval, digest or manifest bytes differ'); }
}

export function verifyWorkflowGate(manifest, gate, dependencies, { currentRun, manifestBytes, manifestMembers } = {}) {
  const hint = manifest.workflowRun;
  const paths = [gate.workflow.split('#')[0], ...(gate.workflowCallers ?? [])];
  const match = /^([\w.-]+\/[\w.-]+)\/(\.github\/workflows\/[\w.-]+\.yml)@(refs\/(?:heads|tags)\/[^\s]+)$/u.exec(hint?.workflowRef ?? '');
  assert.ok(match && match[1] === evidenceRepository && paths.includes(match[2]), 'UNVERIFIED: workflow repository/path differs');
  const [, repository, workflowPath, ref] = match;
  assert.ok([requiredOperatorInput("WASALX_QUALITY_WORKFLOW_PATH"), requiredOperatorInput("WASALX_RELEASE_WORKFLOW_PATH")].includes(workflowPath),
    'UNVERIFIED: unsupported workflow path');
  const quality = workflowPath === requiredOperatorInput("WASALX_QUALITY_WORKFLOW_PATH");
  const jobId = gate.workflow.split('#')[1];
  assert.equal(hint.job, jobId, 'UNVERIFIED: workflow job differs');
  const publishing = jobId === 'publish-manifest';
  assert.ok(quality ? publishing ? ref === 'refs/heads/dev' : ['refs/heads/dev', 'refs/heads/main'].includes(ref)
    : ref === 'refs/heads/main' || /^refs\/tags\/v[0-9]/u.test(ref), 'UNVERIFIED: unsupported workflow ref');
  const evidence = lookupWorkflowEvidence({ repository, runId: Number(hint.runId), runAttempt: Number(hint.runAttempt),
    headSha: manifest.candidateSha, candidateTree: manifest.candidateTree, workflowPath, refs: [ref],
    events: !publishing ? ['workflow_dispatch'] : ref.startsWith('refs/tags/') || quality ? ['push'] : ['workflow_dispatch'],
    // Only an explicitly identified consumer in this producing run may observe its completed upstream job.
    allowInProgress: currentRun?.id === Number(hint.runId) && currentRun.attempt === Number(hint.runAttempt)
      && currentRun.workflowRef === hint.workflowRef && currentRun.headSha === manifest.candidateSha }, dependencies);
  const name = jobId === 'zammad-compatibility' ? 'Zammad current and previous compatibility'
    : jobId === 'publish-manifest' ? `${quality ? 'Publish qualified immutable candidate / ' : ''}Publish signed digest manifest and Helm handoff` : undefined;
  assert.ok(name, 'UNVERIFIED: unsupported workflow job');
  const job = verifiedWorkflowJob(evidence, name);
  const members = manifestMembers ?? [{ path: publishing ? `${manifest.gate}.json`
    : `release-evidence/${manifest.candidateSha}/${manifest.gate}.json`, bytes: manifestBytes }];
  const artifact = verifyWorkflowArtifact(evidence, job, manifest, members, publishing, dependencies);
  return { ...job, evidenceArtifact: artifact };
}
