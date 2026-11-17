import {open} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
export async function persistFreshMailRecord(directory,name,value){assert.match(name,/^[A-Za-z0-9_-]+$/);const file=await open(join(directory,name+'.json'),'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}}

export function isOwnedMailPath(root,candidate){const child=relative(root,candidate);return Boolean(child)&&!child.startsWith('..')&&!isAbsolute(child);}
