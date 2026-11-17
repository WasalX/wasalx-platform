// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Existing relay calls executeGuest; root calls runBrowser with its Page handles.
// Only standard-library imports before the complete frozen driver closure check.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
// The factor helper is invoked as a subprocess, outside the import scanner.
const mandatory=['meta-deletion-dev-fixture.mjs','meta-deletion-journey.mjs','meta-deletion-dev-guest.mjs','meta-deletion-dev-browser.mjs','meta-deletion-dev-entry.mjs'];
export async function verifyDeletionDriverClosure(manifestPath,manifestSha256,{guest=false}={}){
 try{
  if(!/^[0-9a-f]{64}$/u.test(manifestSha256))throw Error();
  const bytes=await readFile(manifestPath);if(bytes.length>131072||sha(bytes)!==manifestSha256)throw Error();
  if(guest){const s=await lstat(manifestPath);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||await realpath(manifestPath)!==manifestPath)throw Error();}
  const m=JSON.parse(bytes),files=m.p11?.driverFiles,root=dirname(fileURLToPath(import.meta.url));
  if(!Array.isArray(files)||files.length<mandatory.length||files.length>16||new Set(files.map(f=>f.path)).size!==files.length||mandatory.some(name=>!files.some(f=>f.path===name)))throw Error();
  for(const f of files){const path=resolve(root,f.path),part=relative(root,path);if(isAbsolute(f.path)||!part||part.startsWith('..')||!/^[0-9a-f]{64}$/u.test(f.sha256)||await realpath(path)!==path)throw Error();
   const raw=await readFile(path);if(sha(raw)!==f.sha256)throw Error();
   if(guest){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw Error();}
   if(f.path.endsWith('.mjs'))for(const hit of raw.toString('utf8').matchAll(/(?:from\s*|import\s*(?:\(\s*)?)(['"])(\.[^'"]+)\1/g)){const target=relative(root,resolve(dirname(path),hit[2])).replaceAll('\\','/');if(!files.some(row=>row.path===target))throw Error();}
  }
  if((files.find(f=>f.path==='meta-deletion-dev-entry.mjs').sha256!==m.guestDriverSha256 || files.find(f=>f.path==='meta-deletion-dev-guest.mjs').sha256!==m.p11.guestModuleSha256))throw Error();
  return m;
 }catch{throw Error('P11 DRIVER_CLOSURE');}
}
