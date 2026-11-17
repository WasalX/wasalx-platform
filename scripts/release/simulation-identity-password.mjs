import assert from'node:assert/strict';
export function verifyIdentityPassword(password,username,policy){
 assert.equal(typeof password,'string');assert.equal(typeof policy,'string');
 const supported=new Set(['length','digits','lowerCase','upperCase','specialChars','notUsername']);
 for(const rule of policy.split(' and ')){const match=/^([A-Za-z]+)\(([^)]*)\)$/.exec(rule);assert(match&&supported.has(match[1]),'Unsupported identity password policy; inspect before creating user');const name=match[1];if(name==='notUsername'){assert.notEqual(password.toLowerCase(),username.toLowerCase(),'Password policy notUsername');continue;}const minimum=Number(match[2]);assert(Number.isSafeInteger(minimum)&&minimum>=0);const count=name==='length'?password.length:name==='digits'?(password.match(/[0-9]/g)??[]).length:name==='lowerCase'?(password.match(/[a-z]/g)??[]).length:name==='upperCase'?(password.match(/[A-Z]/g)??[]).length:(password.match(/[^A-Za-z0-9]/g)??[]).length;assert(count>=minimum,'Password policy '+name);}
 return true;
}
export function safeIdentityAdminError(body){const allowed=new Set(['invalidPasswordMinLengthMessage','invalidPasswordMinDigitsMessage','invalidPasswordMinLowerCaseCharsMessage','invalidPasswordMinUpperCaseCharsMessage','invalidPasswordMinSpecialCharsMessage','invalidPasswordNotUsernameMessage']);const value=body?.error??body?.errorMessage;return allowed.has(value)?value:'unclassified_admin_error';}
