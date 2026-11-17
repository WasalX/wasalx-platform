import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat,mkdir,readFile,open} from 'node:fs/promises';
export function platformProxyPath(path){
 assert.equal(typeof path,'string');
 const tail=path.replace(/^\/platform\/v1\//,'').replace(/^\/api\/platform-console\//,'').replace(/^\//,'');
 assert.match(tail,/^waha-workers(?:\/[A-Za-z0-9._%-]+\/mode)?$/);
 return '/api/platform-console/'+tail;
}
export function validatePlatformRealm(r,hasFactor){
 assert.equal(r.ownerCount,1);assert.equal(r.algorithm,'HmacSHA256');assert.equal(Number(r.digits),6);assert.equal(Number(r.period),30);
 assert.equal(r.otpCount,hasFactor?1:0,'Existing enrollment must match private platform factor');
 assert.equal(r.configureRequired,hasFactor?0:1,'Enrollment state requires reconciliation');
}
export function assertPlatformStoredSession(raw,expectedSubject){
 let stored;try{stored=JSON.parse(raw);}catch{throw Error('Stored platform session invalid');}
 assert.equal(stored?.subject,expectedSubject,'Browser platform session subject mismatch');
 return{actorRef:'sha256:'+createHash('sha256').update(expectedSubject).digest('hex'),tenantRef:null,role:'platform_operator',realm:'wasalx-platform',audience:'wasalx-platform-api',matched:true};
}
