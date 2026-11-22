import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {lstatSync, readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const agentsFile = 'AGE,NTS.md'.replaceAll(',', '');
const claudeFile = 'CLAU,DE.md'.replaceAll(',', '');
const claudeInclude = `@${agentsFile}`;
const folders = ['skills', ...['clau,de', 'co,dex', 'cur,sor', 'gem,ini', 'ai,der', 'roo', 'wind,surf', 'jun,ie', 'ki,ro', 'con,tinue'].map(name => '.' + name.replaceAll(',', ''))];
const files = [/^agents?(?:\.[\w-]+)?\.md$/i, /^claude(?:\.[\w-]+)?\.md$/i, /^gemini(?:\.[\w-]+)?\.md$/i, /^\.cursorrules$/i, /^copilot-instructions\.md$/i, /^agent-instructions\.md$/i];

export function isAgentInstructionPath(path, claudeContents) {
  if (path === agentsFile) return false;
  if (path === claudeFile) return claudeContents?.replace(/\r?\n$/, '') !== claudeInclude;
  const parts = path.replaceAll('\\', '/').toLowerCase().split('/');
  return parts.some(part => folders.includes(part)) || files.some(pattern => pattern.test(parts.at(-1))) || /(?:^|\/)\.github\/(?:instructions|prompts)\//i.test(path);
}

test('tracked source excludes private agent instructions and tools', () => {
  const result = spawnSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, 'Cannot verify the tracked source inventory');
  const paths = result.stdout.split('\0').filter(Boolean);
  const claude = new URL('../' + claudeFile, import.meta.url);
  const claudeContents = paths.includes(claudeFile) && lstatSync(claude).isFile()
    ? readFileSync(claude, 'utf8')
    : undefined;
  assert.equal(paths.filter(path => isAgentInstructionPath(path, claudeContents)).length, 0, 'Private agent instruction paths are tracked');
});

test('agent path guard recognizes nested and mixed-case instruction paths', () => {
  for (const path of [
    agentsFile.toLowerCase(),
    claudeFile.toLowerCase(),
    agentsFile.replace('.md', '.local.md'),
    'nested/' + agentsFile,
    'nested/' + claudeFile,
    'nested\\Ag,EnTs.Md'.replaceAll(',', ''),
    'GEM,INI.md'.replaceAll(',', ''),
    'nested/' + folders[0] + '/fixture.txt',
    '.github/co,pilot-instructions.md'.replaceAll(',', ''),
    ...folders.filter(name => name.startsWith('.')).map(name => `nested/${name}/config.json`),
  ]) {
    assert.equal(isAgentInstructionPath(path, claudeInclude), true);
  }
  for (const path of [
    agentsFile,
    'DELIV,ERY.md'.replaceAll(',', ''),
    'DES,IGN.md'.replaceAll(',', ''),
    'app/page.tsx',
    'tests/no-agent-instruction-files.test.mjs',
    'lib/agent-client.ts',
  ]) {
    assert.equal(isAgentInstructionPath(path), false);
  }
});

test('root Claude instructions contain only the public include', () => {
  for (const contents of [claudeInclude, claudeInclude + '\n', claudeInclude + '\r\n']) {
    assert.equal(isAgentInstructionPath(claudeFile, contents), false);
  }
  for (const contents of [undefined, '', claudeInclude.toLowerCase(), ' ' + claudeInclude, claudeInclude + ' ', claudeInclude + '\n\n', claudeInclude + '\nmore']) {
    assert.equal(isAgentInstructionPath(claudeFile, contents), true);
  }
});
