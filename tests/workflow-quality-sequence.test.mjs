import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import {selectQualityConfigs} from '../scripts/release/simulation-remaining-quality.mjs';
test('selected workflow quality never opens unknown-dependent review before lifecycle',()=>{
 const configs=[{name:'studio',prefixes:['workflow-studio/canvas','workflow-studio/immutable']},{name:'cases',prefixes:['cases-deliveries/case']},{name:'reviews',prefixes:['cases-deliveries/recovery']}];
 const definitions=[{id:'workflow-studio/canvas::ui-quality::keyboard-focus'},{id:'cases-deliveries/recovery::ui-quality::keyboard-focus'}];
 assert.deepEqual(selectQualityConfigs(configs,definitions.filter(t=>t.id.startsWith('workflow-studio/'))).map(c=>c.name),['studio']);
 assert.deepEqual(selectQualityConfigs(configs,definitions.filter(t=>!t.id.startsWith('workflow-studio/'))).map(c=>c.name),['reviews']);
 assert.deepEqual(selectQualityConfigs(configs,[]),[]);
});
test('workflow keyboard failures retain the ordered safe assertion phase',()=>{const source=readFileSync(new URL('../scripts/release/simulation-remaining-quality.mjs',import.meta.url),'utf8'),phases=['restore-normal-page','read-studio-catalog','find-retained-draft','open-draft','wait-review-trigger','resolve-trigger','reach-trigger-by-tab','activate-trigger-with-enter','wait-dialog','assert-dialog-order','assert-visible-focus','escape-dialog','wait-dialog-hidden','verify-trigger-focus-return'];let prior=-1;for(const phase of phases){const current=source.indexOf(`keyboardPhase='${phase}'`);assert(current>prior,`Missing or unordered keyboard phase ${phase}`);prior=current;}assert(source.includes("()=>({diagnosticPhase:keyboardPhase,diagnosticBoundary:'simulation-remaining-quality:keyboard-focus'})"));assert(!source.includes('diagnosticError:e.message'));});
