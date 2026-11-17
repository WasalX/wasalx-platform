import test from "node:test";
import assert from "node:assert/strict";
import {validatePin} from "../scripts/fetch-zammad-addon.mjs";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("add-on pin rejects branches, shortened SHAs and another repository",()=>{
 const pin={repository:"WasalX/wasalx-zammad-addon-next",commit:"a".repeat(40),packageSha256:"b".repeat(64)};
 assert.equal(validatePin(pin),pin);
 for(const commit of ["main","a".repeat(8),"A".repeat(40)]) assert.throws(()=>validatePin({...pin,commit}));
 assert.throws(()=>validatePin({...pin,repository:"other/repository"}));
 assert.throws(()=>validatePin({...pin,packageSha256:"wrong"}));
});
test("fetch stages pinned Ruby contracts and fixtures without copying another Node suite or replacing changed input",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wasalx-addon-contracts-")),checkout=join(root,".zammad-addon");
 const git=(...args)=>execFileSync("git",["-C",checkout,...args],{encoding:"utf8",windowsHide:true,timeout:10000});
 try{
  await mkdir(checkout);await mkdir(join(root,"scripts"));
  for(const dir of ["zammad-package","build/zammad","tests/fixtures"])await mkdir(join(checkout,dir),{recursive:true});
  for(const file of ["zammad-package/product.rb","build/zammad/package.zpm","tests/contract.rb","tests/fixtures/mail.txt","tests/other.test.ts"])await writeFile(join(checkout,file),"synthetic product fixture\n");
  git("init","--quiet","--initial-branch=main");git("add",".");
  const stamp=execFileSync(process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"/bin/bash",["-c","date -u +%Y-%m-%dT%H:%M:%SZ"],{encoding:"utf8",windowsHide:true}).trim();
  execFileSync("git",["-C",checkout,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null","commit","--quiet","-m","fixture"],{env:{...process.env,GIT_AUTHOR_DATE:stamp,GIT_COMMITTER_DATE:stamp},windowsHide:true,timeout:10000});
  await writeFile(join(root,"zammad-addon.json"),JSON.stringify({repository:"WasalX/wasalx-zammad-addon-next",commit:git("rev-parse","HEAD").trim(),packageSha256:"b".repeat(64)}));
  const entry=join(root,"scripts/fetch-zammad-addon.mjs");await writeFile(entry,await readFile(new URL("../scripts/fetch-zammad-addon.mjs",import.meta.url)));
  const run=()=>spawnSync(process.execPath,[entry],{cwd:root,encoding:"utf8",windowsHide:true,timeout:10000});
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(join(root,"tests/contract.rb"),"utf8"),"synthetic product fixture\n");await access(join(root,"tests/fixtures/mail.txt"));
  await assert.rejects(access(join(root,"tests/other.test.ts")),{code:"ENOENT"});
  assert.equal(run().status,0);await writeFile(join(root,"tests/contract.rb"),"changed\n");assert.notEqual(run().status,0);assert.equal(await readFile(join(root,"tests/contract.rb"),"utf8"),"changed\n");
 }finally{await rm(root,{recursive:true,force:true});}
});
