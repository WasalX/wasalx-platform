import test from "node:test";
import assert from "node:assert/strict";
import {validatePin,validatePublicSource} from "../scripts/fetch-zammad-addon.mjs";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtemp,mkdir,readFile,writeFile,rm,access,rename} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
test("installer and deployment package pins agree with the public add-on source",async()=>{
 const read=path=>readFile(new URL("../"+path,import.meta.url),"utf8");
 const pin=validatePin(JSON.parse(await read("zammad-addon.json")));
 assert.equal(pin.reference,pin.repository+"@"+pin.commit);
 const catalog=JSON.parse(await read("release/installer-images.json"));
 assert.deepEqual(catalog.tenantProvisioning.package,{version:pin.packageVersion,sha256:pin.packageSha256});
 const dockerfile=await read("infra/docker/Dockerfile.zammad");
 assert.equal(dockerfile.match(/^ADD (https:\/\/github\.com\/\S+\.git#[a-f0-9]{40}) \/src$/mu)?.[1],"https://github.com/"+pin.repository+".git#"+pin.commit);
 for(const [file,pattern] of [
  ["infra/docker/Dockerfile.zammad",/^ARG WASALX_PACKAGE_SHA256=([a-f0-9]{64})$/gmu],
  ["Dockerfile.workspace-configurator",/['"]([a-f0-9]{64})['"]/gu],
  ["compose.full.yaml",/(?:WASALX_(?:ZAMMAD_)?PACKAGE_SHA256: [^\n]*?|^\s*')([a-f0-9]{64})(?:\}|')?$/gmu],
  [".env.example",/^WASALX_ZAMMAD_PACKAGE_SHA256=([a-f0-9]{64})$/gmu],
  ["infra/helm/wasalx/values.yaml",/packageSha256: "([a-f0-9]{64})"/gu],
  ["scripts/build-zammad-previous-stable-image.sh",/WASALX_PACKAGE_SHA256="([a-f0-9]{64})"/gu],
 ]) {
  const digests=[...(await read(file)).matchAll(pattern)].map(match=>match[1]);
  assert.ok(digests.length>0,file);
  assert.ok(digests.every(digest=>digest===pin.packageSha256),file);
 }
 const ci=await read(".github/workflows/ci.yml");
 assert.match(ci,/pnpm run zammad:package/u);
 assert.doesNotMatch(ci,/revision=[a-f0-9]{40}|addon=https:/u);
 assert.doesNotMatch(await read(".github/workflows/branch-image.yml"),/vars\.PUBLIC_ADDON_SOURCE/u);
});
test("public add-on source requires an HTTPS repository URL and full immutable commit",()=>{
 const source={repository:"https://github.com/example/addon",commit:"a".repeat(40)};
 assert.deepEqual(validatePublicSource(source),{repository:"example/addon",commit:source.commit});
 for(const bad of [{...source,repository:"https://user:password@github.com/example/addon"},
   {...source,repository:"ssh://github.com/example/addon"},{...source,commit:"main"},{...source,extra:true}]) assert.throws(()=>validatePublicSource(bad));
});
test("add-on pin rejects branches, shortened SHAs and another repository",()=>{
 const pin={repository:"WasalX/wasalx-zammad-addon",commit:"a".repeat(40),packageSha256:"b".repeat(64)};
 assert.equal(validatePin(pin),pin);
 for(const commit of ["main","a".repeat(8),"A".repeat(40)]) assert.throws(()=>validatePin({...pin,commit}));
 assert.throws(()=>validatePin({...pin,repository:"other/repository"}));
 assert.throws(()=>validatePin({...pin,packageSha256:"wrong"}));
});
test("fetch preserves Git bytes with autocrlf, stages contracts and refuses changed input",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wasalx-addon-contracts-")),checkout=join(root,".zammad-addon"),origin=join(root,"origin");
 const git=(...args)=>execFileSync("git",["-C",checkout,...args],{encoding:"utf8",windowsHide:true,timeout:10000});
 try{
  await mkdir(checkout);await mkdir(join(root,"scripts"));
  for(const dir of ["zammad-package","build/zammad","tests/fixtures"])await mkdir(join(checkout,dir),{recursive:true});
  for(const file of ["zammad-package/product.rb","zammad-package/product.coffee","build/zammad/package.zpm","tests/contract.rb","tests/fixtures/mail.txt","tests/other.test.ts"])await writeFile(join(checkout,file),"synthetic product fixture\n");
  for(const file of ["LICENSE","COPYING","THIRD-PARTY-NOTICES"])await writeFile(join(checkout,file),"synthetic licence fixture\n");
  git("init","--quiet","--initial-branch=main");git("add",".");
  const stamp=execFileSync(process.platform==="win32"?"C:/Program Files/Git/usr/bin/date.exe":"/usr/bin/date",["-u","+%Y-%m-%dT%H:%M:%SZ"],{encoding:"utf8",windowsHide:true}).trim();
  execFileSync("git",["-C",checkout,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null","commit","--quiet","-m","fixture"],{env:{...process.env,GIT_AUTHOR_DATE:stamp,GIT_COMMITTER_DATE:stamp},windowsHide:true,timeout:10000});
  await writeFile(join(root,"zammad-addon.json"),JSON.stringify({repository:"WasalX/wasalx-zammad-addon",commit:git("rev-parse","HEAD").trim(),packageSha256:"b".repeat(64)}));
  await rename(checkout,origin);
  const entry=join(root,"scripts/fetch-zammad-addon.mjs");await writeFile(entry,await readFile(new URL("../scripts/fetch-zammad-addon.mjs",import.meta.url)));
  const run=(source="")=>spawnSync(process.execPath,[entry],{cwd:root,encoding:"utf8",windowsHide:true,timeout:10000,env:{...process.env,PUBLIC_ADDON_SOURCE:source,
   GIT_CONFIG_COUNT:"2",GIT_CONFIG_KEY_0:"url."+pathToFileURL(origin).href+".insteadOf",GIT_CONFIG_VALUE_0:"https://github.com/WasalX/wasalx-zammad-addon.git",
   GIT_CONFIG_KEY_1:"core.autocrlf",GIT_CONFIG_VALUE_1:"true"}});
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(join(root,"zammad-package/product.coffee"),"utf8"),"synthetic product fixture\n");
  const rejected=run(JSON.stringify({repository:"https://github.com/example/addon",commit:git("rev-parse","HEAD").trim()}));assert.notEqual(rejected.status,0);
  const publicResult=run(JSON.stringify({repository:"https://github.com/WasalX/wasalx-zammad-addon",commit:git("rev-parse","HEAD").trim()}));assert.equal(publicResult.status,0,publicResult.stderr);
  for(const name of ["LICENSE","COPYING","THIRD-PARTY-NOTICES"])assert.equal(await readFile(join(root,"build/addon-licenses",name),"utf8"),"synthetic licence fixture\n");
  assert.equal(await readFile(join(root,"tests/contract.rb"),"utf8"),"synthetic product fixture\n");await access(join(root,"tests/fixtures/mail.txt"));
  await assert.rejects(access(join(root,"tests/other.test.ts")),{code:"ENOENT"});
  assert.equal(run().status,0);await writeFile(join(root,"tests/contract.rb"),"changed\n");assert.notEqual(run().status,0);assert.equal(await readFile(join(root,"tests/contract.rb"),"utf8"),"changed\n");
 }finally{await rm(root,{recursive:true,force:true});}
});
