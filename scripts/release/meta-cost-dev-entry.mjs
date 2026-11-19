// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Same fixed staged-closure boundary as existing DEV entries. No work on import.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
const equivalent=p=>process.platform==='win32'?p.replaceAll('\\','/'):p;
export const costDriverFiles=['meta-cost-dev-contract.mjs','meta-cost-dev-guest.mjs','meta-cost-dev-entry.mjs','meta-cost-dev-privacy.mjs','meta-cost-operator-journey.mjs','meta-cost-statement-journey.mjs','seed-simulation-group.mjs','meta-template-dev-contract.mjs','meta-template-dev-guest.mjs','meta-template-dev-browser.mjs','journeys.mjs','access-ui.mjs','meta-transition-dev-contract.mjs','meta-deletion-dev-browser.mjs','meta-deletion-dev-guest.mjs','meta-deletion-dev-fixture.mjs','meta-deletion-journey.mjs','meta-privacy-outcome-readback.mjs','meta-privacy-outcome-artifact.mjs','meta-privacy-outcome-dispatch.mjs','meta-privacy-outcome-journey.mjs','meta-privacy-outcome-assertions.mjs','simulation-rails-json.mjs'];
export async function verifyCostDriverClosure(manifestPath,manifestSha256,{guest=false}={}){try{
 if(!/^[a-f0-9]{64}$/u.test(manifestSha256))throw Error();const bytes=await readFile(manifestPath);if(bytes.length>131072||sha(bytes)!==manifestSha256)throw Error();
 const stat=await lstat(manifestPath);if(!stat.isFile()||stat.isSymbolicLink()||equivalent(await realpath(manifestPath))!==equivalent(resolve(manifestPath))||guest&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))throw Error();
 const m=JSON.parse(bytes),files=m.p10?.driverFiles,root=dirname(fileURLToPath(import.meta.url));if(!Array.isArray(files)||files.length!==costDriverFiles.length||new Set(files.map(f=>f.path)).size!==files.length||costDriverFiles.some(name=>!files.some(f=>f.path===name)))throw Error();
 for(const f of files){const path=resolve(root,f.path),part=relative(root,path),s=await lstat(path);if(isAbsolute(f.path)||!part||part.startsWith('..')||!s.isFile()||s.isSymbolicLink()||equivalent(await realpath(path))!==equivalent(path)||!/^[a-f0-9]{64}$/u.test(f.sha256)||guest&&(s.uid!==process.getuid()||(s.mode&0o077)!==0))throw Error();const raw=await readFile(path);if(sha(raw)!==f.sha256)throw Error();
  if(f.path.endsWith('.mjs'))for(const hit of raw.toString('utf8').matchAll(/(?:from\s*|import\s*(?:\(\s*)?)(['"])(\.[^'"]+)\1/g)){const target=relative(root,resolve(dirname(path),hit[2])).replaceAll('\\','/');if(!files.some(row=>row.path===target))throw Error();}
 }
 if(files.find(f=>f.path==='meta-cost-dev-entry.mjs').sha256!==m.guestDriverSha256||['contract','guest'].some(kind=>files.find(f=>f.path==='meta-cost-dev-'+kind+'.mjs').sha256!==m.p10[kind+'Sha256']))throw Error();return m;
 }catch{throw Error('P10 DRIVER_CLOSURE');}}
