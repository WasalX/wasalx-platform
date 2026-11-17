import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,unlink} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareNativeTypecheck({root,manifest,action,fixtureRoot,fetchFile=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(30000)});assert(r.ok,'Pinned upstream fixture unavailable');return Buffer.from(await r.arrayBuffer());}}) {
  root=resolve(root);assert(['restore','remove'].includes(action));assert(/^[a-f0-9]{40}$/.test(manifest.revision));
  if(fixtureRoot){fixtureRoot=resolve(fixtureRoot);const s=await lstat(fixtureRoot);assert(s.isDirectory()&&!s.isSymbolicLink());}
  assert(manifest.files.length>0&&manifest.files.length<=128);
  const paths=new Set();
  for(const f of [...manifest.baseFiles,...manifest.files]) {
    assert(typeof f.path==='string'&&!isAbsolute(f.path)&&f.path.split('/').every(part=>part&&part!=='.'&&part!=='..')&&!f.path.includes('\\'));
    assert(/^[a-f0-9]{64}$/.test(f.sha256));assert(!paths.has(f.path));paths.add(f.path);
    const destination=resolve(root,f.path);assert(!relative(root,destination).startsWith('..'));
    for(let p=dirname(destination);;p=dirname(p)) {try {const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink(),'Native fixture parent must be an ordinary directory');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===root)break;}
  }
  for(const f of manifest.baseFiles){const p=resolve(root,f.path),s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(sha(await readFile(p)),f.sha256,'Pinned native base differs: '+f.path);}
  for(const f of manifest.files)assert(f.path.startsWith('app/frontend/'),'Only frontend typecheck prerequisites may be restored');
  const receipt=resolve(root,'.wasalx-typecheck-fixtures.json'),identity=sha(JSON.stringify(manifest));
  if(action==='remove') {
    const saved=JSON.parse(await readFile(receipt,'utf8'));assert.equal(saved.manifestSha256,identity);
    // Verify every owned file before deleting any; do not delete changed source.
    for(const f of manifest.files){const p=resolve(root,f.path),s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(sha(await readFile(p)),f.sha256);}
    for(const f of manifest.files)await unlink(resolve(root,f.path));
    await unlink(receipt);return {removed:manifest.files.length};
  }
  await assert.rejects(lstat(receipt),e=>e.code==='ENOENT');
  for(const f of manifest.files)await assert.rejects(lstat(resolve(root,f.path)),e=>e.code==='ENOENT');
  const bytes=[];
  for(let offset=0;offset<manifest.files.length;offset+=8)bytes.push(...await Promise.all(manifest.files.slice(offset,offset+8).map(async f=>{let b;if(fixtureRoot){const p=resolve(fixtureRoot,f.path);const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());b=await readFile(p);}else b=await fetchFile('https://raw.githubusercontent.com/zammad/zammad/'+manifest.revision+'/'+f.path);assert.equal(sha(b),f.sha256,'Pinned upstream bytes differ: '+f.path);return b;})));
  await writeFile(receipt,JSON.stringify({manifestSha256:identity}),{flag:'wx',mode:0o600});
  for(let i=0;i<manifest.files.length;i++){const p=resolve(root,manifest.files[i].path);await mkdir(dirname(p),{recursive:true});await writeFile(p,bytes[i],{flag:'wx',mode:0o644});}
  return {restored:manifest.files.length,upstreamRevision:manifest.revision};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const[action,root,manifestPath,fixtureRoot]=process.argv.slice(2);assert(root&&manifestPath);console.log(JSON.stringify(await prepareNativeTypecheck({action,root,manifest:JSON.parse(await readFile(manifestPath,'utf8')),fixtureRoot})));}
