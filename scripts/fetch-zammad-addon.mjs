import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile, cp, mkdir, access, readdir} from "node:fs/promises";
import {lstat} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
export function validatePin(pin, approvedRepository = "WasalX/wasalx-zammad-addon-next") {
  assert(/^[a-f0-9]{40}$/.test(pin.commit));
  assert.equal(pin.repository, approvedRepository);
  assert(/^[a-f0-9]{64}$/.test(pin.packageSha256));
  return pin;
}
export function validatePublicSource(source) {
  assert.deepEqual(Object.keys(source).sort(), ["commit", "repository"]);
  assert(typeof source.repository === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository));
  assert(typeof source.commit === "string" && /^[a-f0-9]{40}$/.test(source.commit));
  return {repository: source.repository.slice("https://github.com/".length).replace(/\.git$/, ""), commit: source.commit};
}
async function main() {
  const original=JSON.parse(await readFile(new URL("../zammad-addon.json",import.meta.url),"utf8"));
  const source=process.env.PUBLIC_ADDON_SOURCE ? validatePublicSource(JSON.parse(process.env.PUBLIC_ADDON_SOURCE)) : null;
  const pin=source ? validatePin({...original,...source},source.repository) : validatePin(original);
  const checkout=resolve(".zammad-addon");
  function git(args) { const r=spawnSync("git",args,{encoding:"utf8",windowsHide:true,timeout:120000}); assert.equal(r.status,0,"Pinned add-on checkout failed"); return r.stdout.trim(); }
  let existing=false;
  try { await access(checkout); existing=true; } catch(error) { if(error.code!=="ENOENT") throw error; }
  if(!existing) {
    await mkdir(checkout);
    git(["init","--quiet",checkout]);
    git(["-C",checkout,"-c","core.hooksPath=/dev/null",...(source ? ["-c","credential.helper="] : []),"fetch","--depth=1","https://github.com/"+pin.repository+".git",pin.commit]);
    assert.equal(git(["-C",checkout,"rev-parse","FETCH_HEAD"]),pin.commit);
    git(["-C",checkout,"-c","core.hooksPath=/dev/null","checkout","--detach","FETCH_HEAD"]);
  }
  assert.equal(git(["-C",checkout,"rev-parse","HEAD"]),pin.commit);
  assert.equal(git(["-C",checkout,"status","--porcelain"]),"");
  const contracts=(await readdir(resolve(checkout,"tests"))).filter(name=>name.endsWith(".rb")).map(name=>"tests/"+name);
  for(const path of ["zammad-package","build/zammad","tests/fixtures",...contracts]) {
    await mkdir(resolve(path,".."),{recursive:true});
    await cp(resolve(checkout,path),path,{recursive:true,errorOnExist:false,force:false,filter:async(source,destination)=>{
      let present; try { present=await lstat(destination); } catch(error) { if(error.code!=="ENOENT") throw error; return true; }
      assert(!present.isSymbolicLink(),"Add-on destination must not be a symlink");
      if(present.isDirectory()) return true;
      assert((await readFile(source)).equals(await readFile(destination)),"Refusing to replace changed add-on input");
      return false;
    }});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
