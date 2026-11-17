import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const bash=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"/bin/bash";
test("corresponding source requires its exact clean pinned repository",{skip:!existsSync(bash)},async()=>{
 const root=await mkdtemp(join(dirname(fileURLToPath(import.meta.url)),".source-pin-"));
 const checkout=join(root,".zammad-addon"),scripts=join(root,"scripts");
 const env={...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_COMMITTER_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_EMAIL:"fixture@example.invalid"};
 const command=(exe,args,cwd=checkout)=>spawnSync(exe,args,{cwd,env,encoding:"utf8",windowsHide:true,timeout:20000});
 try {
  await mkdir(checkout);await mkdir(scripts);await mkdir(join(checkout,"zammad-package"));
  await writeFile(join(checkout,"zammad-package/package-source.json"),JSON.stringify({version:"1.0.0"}));
  assert.equal(command("git",["init","--quiet","--initial-branch=main"]).status,0);
  assert.equal(command("git",["add","."]).status,0);
  assert.equal(command("git",["-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null","commit","--quiet","-m","fixture"]).status,0);
  const commit=command("git",["rev-parse","HEAD"]).stdout.trim();
  const script=join(scripts,"build-corresponding-source.sh");
  await writeFile(script,await readFile(new URL("../scripts/build-corresponding-source.sh",import.meta.url)));
  await writeFile(join(root,"zammad-addon.json"),JSON.stringify({commit:"a".repeat(40)}));
  const denied=command(bash,[script,join(root,"denied")],root);
  assert.equal(denied.status,2);assert.match(denied.stderr,/pinned commit/);assert(!(await readdir(root,{recursive:true})).some(path=>path.endsWith(".tar.gz")));
  await writeFile(join(root,"zammad-addon.json"),JSON.stringify({commit}));
  const accepted=command(bash,[script,join(root,"accepted")],root);
  assert.equal(accepted.status,0,accepted.stderr);assert.equal((await readdir(root,{recursive:true})).filter(path=>path.endsWith(".tar.gz")).length,1);
 } finally {await rm(root,{recursive:true,force:true});}
});
