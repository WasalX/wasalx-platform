import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {relativeModuleDependencies} from '../scripts/release/simulation-module-dependencies.mjs';

test('manifest freezes real imports without treating embedded worker programs as dependencies',async()=>{
 const source = `
 import './side-effect.mjs';
 import {x} from './static.mjs';
 export {x} from './export.mjs';
 const load = () => import('./dynamic.mjs');
 const worker = 'import {testRules} from "./dist/lib/domain.js"';
 const template = \`import './embedded.mjs'\`;
 // import './comment.mjs';
 import fs from 'node:fs';
 `;
 assert.deepEqual(relativeModuleDependencies(source),['./side-effect.mjs','./static.mjs','./export.mjs','./dynamic.mjs']);
 const workerStage=await readFile(new URL('../scripts/release/simulation-rule-preview.mjs',import.meta.url),'utf8');
 assert(!relativeModuleDependencies(workerStage).includes('./dist/lib/domain.js'));
});
