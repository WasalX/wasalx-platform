import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {requiredOperatorInput} from '../scripts/release/operator-input.mjs';

test('operator inputs fail closed without exposing their contents', () => {
  for (const value of [undefined, '', '  ', 'fixture\nvalue', 'fixture\0value']) {
    assert.throws(() => requiredOperatorInput('WASALX_INPUT', {WASALX_INPUT: value}), {message: 'Required operator input is unavailable: WASALX_INPUT'});
  }
  assert.equal(requiredOperatorInput('WASALX_INPUT', {WASALX_INPUT: '/operator-supplied/config.json'}), '/operator-supplied/config.json');
});

test('live provider entry refuses CI before reading its runtime inputs', () => {
  const entry = fileURLToPath(new URL('../scripts/release/meta-cost-dev-entry.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry], {encoding: 'utf8', windowsHide: true, env: {...process.env, CI: 'true', GITHUB_ACTIONS: 'true'}});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Live provider drivers must never run in hosted CI/u);
});
