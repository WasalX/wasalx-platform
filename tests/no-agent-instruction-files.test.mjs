import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const folders = ['skills', ...['clau,de', 'co,dex', 'cur,sor', 'gem,ini', 'ai,der', 'roo', 'wind,surf', 'jun,ie', 'ki,ro', 'con,tinue'].map(name => '.' + name.replaceAll(',', ''))];
const files = [/^agents?(?:\.[\w-]+)?\.md$/i, /^claude(?:\.[\w-]+)?\.md$/i, /^gemini(?:\.[\w-]+)?\.md$/i, /^\.cursorrules$/i, /^copilot-instructions\.md$/i, /^agent-instructions\.md$/i];

export function isAgentInstructionPath(path) {
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  return parts.some(part => folders.includes(part)) || files.some(pattern => pattern.test(parts.at(-1))) || /(?:^|\/)\.github\/(?:instructions|prompts)\//i.test(path);
}

test('tracked source excludes private agent instructions and tools', () => {
  const result = spawnSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, 'Cannot verify the tracked source inventory');
  assert.equal(result.stdout.split('\0').filter(Boolean).filter(isAgentInstructionPath).length, 0, 'Private agent instruction paths are tracked');
});

test('agent path guard recognizes nested and mixed-case instruction paths', () => {
  for (const path of ['AGENTS.md', 'nested/CLAUDE.md', 'GEMINI.md', 'nested/' + folders[0] + '/fixture.txt', '.github/copilot-instructions.md', ...folders.filter(name => name.startsWith('.')).map(name => `nested/${name}/config.json`)]) {
    assert.equal(isAgentInstructionPath(path), true);
  }
  for (const path of ['app/page.tsx', 'tests/no-agent-instruction-files.test.mjs', 'lib/agent-client.ts']) assert.equal(isAgentInstructionPath(path), false);
});
