// Subprocess fixture: exercise the real CLI without network or Git credentials.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
const execute = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command === 'git' && args[0] === 'rev-parse') return `${'f'.repeat(40)}\n`;
  if (command !== 'gh') return execute(command, args, options);
  const endpoint = args.at(-1), payload = JSON.parse(readFileSync(process.env.WASALX_TEST_RUNS, 'utf8'));
  const runs = (Array.isArray(payload) ? payload : [payload]).flatMap(page => page.workflow_runs);
  if (endpoint.includes('/jobs?')) {
    const jobs = JSON.parse(readFileSync(process.env.WASALX_TEST_JOBS, 'utf8'));
    return JSON.stringify(Array.isArray(jobs) ? jobs : [jobs]);
  }
  if (endpoint.includes('/git/commits/')) return JSON.stringify([{ sha: endpoint.split('/git/commits/')[1], tree: { sha: 'f'.repeat(40) } }]);
  const id = Number(/\/actions\/runs\/(\d+)/u.exec(endpoint)?.[1]);
  const run = runs.find(item => item.id === id);
  if (!run) throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
  return JSON.stringify([run]);
};
syncBuiltinESMExports();
