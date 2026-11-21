import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(`../scripts/release/${name}`, import.meta.url), 'utf8');

test('all three image-verification consumers use the shared resolver', () => {
  for (const name of ['alpha-test-baseline.mjs', 'automation-coverage.mjs', 'simulation-manifest.mjs']) {
    const text = source(name);
    assert.match(text, /import \{verifiedDeploymentImages\} from '\.\/deployment-image-verification\.mjs';/u, name);
    assert.match(text, /verifiedDeploymentImages\(/u, name);
  }
});

test('automation coverage compares and checks ordinary resolved service rows', () => {
  const text = source('automation-coverage.mjs');
  assert.match(text, /productImages=d=>images\(d\)\.map\(i=>\[i\.service,i\.runningDigest\]\)/u);
  assert.match(text, /proof\.containers\[image\.service\]\.id,image\.containerId/u);
});

test('baseline validates correction reviews even before a PASS consumes the deployment', () => {
  const text = source('alpha-test-baseline.mjs');
  assert.match(text, /Unknown corrected deployment/u);
  assert.match(text, /if \(data\.reviews\.some\(row => row\.kind === 'deployment-image-verification-correction'/u);
});
