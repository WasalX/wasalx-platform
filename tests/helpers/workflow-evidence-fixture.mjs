import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function mockWorkflowApi(run, jobs, artifacts = [], tree = 'f'.repeat(40)) {
  return { treeFor: () => tree, api: (repository, path) => {
    assert.equal(repository, run.repository.full_name);
    if (path === `actions/runs/${run.id}` || path === `actions/runs/${run.id}/attempts/${run.run_attempt}`) return [run];
    if (path === `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`) return [{ jobs }];
    if (path === `actions/runs/${run.id}/artifacts?per_page=100`) return [{ artifacts }];
    if (path === `git/commits/${run.head_sha}`) return [{ sha: run.head_sha, tree: { sha: tree } }];
    throw new Error(`Unexpected mock GitHub API request: ${path}`);
  } };
}

export function mockWorkflowArtifact(run, job, members, release = false) {
  const content = JSON.stringify(members.map(member => [member.path, member.bytes.toString('base64')]));
  const program = `import base64,io,json,sys,tarfile,zipfile
items=[(name,base64.b64decode(value)) for name,value in json.loads(sys.argv[1])]
out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 if sys.argv[2]=='release':
  data=io.BytesIO()
  with tarfile.open(fileobj=data,mode='w:gz') as t:
   for name,value in items:
    info=tarfile.TarInfo('./'+name); info.size=len(value); t.addfile(info,io.BytesIO(value))
  z.writestr('wasalx-release-evidence.tar.gz',data.getvalue())
 else:
  for name,value in items: z.writestr(name,value)
sys.stdout.buffer.write(out.getvalue())`;
  const bytes = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', program, content, release ? 'release' : 'direct'],
    { timeout: 10_000, maxBuffer: 1_048_576, windowsHide: true });
  const artifact = { id: 30, name: release ? `wasalx-release-${run.id}-${run.run_attempt}-aggregate`
    : `wasalx-zammad-compat-${run.id}-${run.run_attempt}`, expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size_in_bytes: bytes.length,
    created_at: new Date((Date.parse(job.started_at) + Date.parse(job.completed_at)) / 2).toISOString(),
    workflow_run: { id: run.id, head_sha: run.head_sha, run_attempt: run.run_attempt } };
  return { artifact, bytes, downloadArtifact: (_repository, id) => { assert.equal(id, artifact.id); return bytes; } };
}
