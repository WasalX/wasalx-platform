import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { bracesPatchHash, bracesPaths, sha256, verifyBracesPatch } from "./verify-braces-patch.mjs";

const [command,args]=process.platform==="win32"
  ? ["cmd.exe",["/d","/s","/c","corepack pnpm audit --json"]]
  : ["pnpm",["audit","--json"]];
const result=spawnSync(command,args,{encoding:"utf8",windowsHide:true,maxBuffer:10_000_000});
if(result.error)throw result.error;
if(result.signal)throw new Error(`pnpm audit terminated by ${result.signal}`);
if(result.status!==0&&result.status!==1)throw new Error(`pnpm audit failed with status ${result.status}: ${result.stderr}`);
if(!result.stdout)throw new Error(`pnpm audit produced no JSON: ${result.stderr}`);
const report=JSON.parse(result.stdout);
if(!report||typeof report!=="object"||Array.isArray(report)||!report.advisories||typeof report.advisories!=="object"||Array.isArray(report.advisories))throw new Error("pnpm audit returned an invalid advisory report");
const advisories=Object.values(report.advisories);
if(advisories.some(advisory=>!advisory||typeof advisory!=="object"||typeof advisory.severity!=="string"||!Array.isArray(advisory.findings)))throw new Error("pnpm audit returned a malformed advisory");
const workspace=await readFile(new URL("../pnpm-workspace.yaml",import.meta.url),"utf8");
const bracesPatch=await readFile(new URL("../patches/braces@3.0.3.patch",import.meta.url));
const lock=await readFile(new URL("../pnpm-lock.yaml",import.meta.url),"utf8");
if(!workspace.includes("braces@3.0.3: patches/braces@3.0.3.patch")||sha256(bracesPatch)!==bracesPatchHash||
  !lock.includes(`  braces@3.0.3: ${bracesPatchHash}`)||
  !lock.includes(`  braces@3.0.3(patch_hash=${bracesPatchHash}):`)||
  [...lock.matchAll(/^\s+braces: (.+)$/gmu)].some(([,version])=>version!==`3.0.3(patch_hash=${bracesPatchHash})`))
  throw new Error("The local braces security patch is missing or unbound");
await verifyBracesPatch();
const bracesAdvisory="GHSA-vfj7-8cjw-p6xm";
const isPatched=advisory=>advisory.findings.length>0&&advisory.github_advisory_id===bracesAdvisory&&advisory.module_name==="braces"&&
  advisory.findings.every(finding=>finding.version==="3.0.3"&&Array.isArray(finding.paths)&&finding.paths.length>0&&finding.paths.every(path=>bracesPaths.includes(path)));
const unresolved=advisories.filter(advisory=>["high","critical"].includes(advisory.severity)&&!isPatched(advisory));
if(unresolved.length){for(const advisory of unresolved)process.stderr.write(`${advisory.severity} ${advisory.github_advisory_id} ${advisory.title}\n`);process.exit(1)}
process.stdout.write(`${JSON.stringify({high_or_critical_unresolved:0,locally_patched:[bracesAdvisory],moderate_or_lower:advisories.filter(advisory=>!["high","critical"].includes(advisory.severity)).length})}\n`);
