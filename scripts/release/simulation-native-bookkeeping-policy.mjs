import{createHash}from'node:crypto';
export const documentHash=query=>createHash('sha256').update(query).digest('hex');
export function admitNativeBookkeeping(row,{ticketId,documentHashes,ownedTaskbars}){
 const op=row?.operationName,v=row?.variables??{};if(!documentHashes?.[op]?.includes(documentHash(String(row?.query??''))))return false;
 if(op==='ticketLiveUserUpsert')return v.id==='gid://zammad/Ticket/'+ticketId&&v.editing===false&&['desktop','mobile'].includes(String(v.app).toLowerCase());
 if(op==='ticketLiveUserDelete')return Object.keys(v).length===2&&v.id==='gid://zammad/Ticket/'+ticketId&&String(v.app).toLowerCase()==='mobile';
 if(op==='onlineNotificationSeen')return Object.keys(v).length===1&&v.objectId==='gid://zammad/Ticket/'+ticketId;
 if(!['userCurrentTaskbarItemTouchLastContact','userCurrentTaskbarItemUpdate'].includes(op))return false;
 const owned=ownedTaskbars?.get(v.id);if(!owned)return false;
 if(op==='userCurrentTaskbarItemTouchLastContact')return Object.keys(v).length===1;
 const input=v.input;if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['app','callback','dirty','key','notify','params','prio','state','objectAttributeValues'].includes(k)))return false;if(Object.keys(v).some(k=>!['id','input'].includes(k)))return false;if(!owned.identityCaptured||!input||input.dirty===true||input.objectAttributeValues?.length)return false;
 if(input.key!==owned.key||input.callback!==owned.callback||input.app!==owned.app)return false;
 // Capture identity parameters from the installed native client's initial request,
 // correlate with this current actor's returned taskbar entity, then freeze them.
 return JSON.stringify(input.params??null)===JSON.stringify(owned.params??null);
}

// Conservative read admission: a named leading read must be the selected operation.
// Any mutation token rejects the whole read document, including additional operations.
// A token in a comment/string may fail closed; never strip syntax using a custom parser.
export function admitNativeRead(row){const query=String(row?.query??'');if(/\bmutation\b/.test(query))return false;const leading=query.match(/^\s*(?:query|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)\b/);return !!leading&&row.operationName===leading[1];}
export function admitNativeBatch(body,policy){const rows=Array.isArray(body)?body:[body];return rows.length>0&&rows.every(r=>admitNativeRead(r)||admitNativeBookkeeping(r,policy));}
export function targetNativeReadIndices(body,policy,isTargetRead){const rows=Array.isArray(body)?body:[body],indices=rows.flatMap((row,index)=>isTargetRead(row)?[index]:[]);if(!indices.length||rows.some((row,index)=>!indices.includes(index)&&!admitNativeRead(row)&&(!policy||!admitNativeBookkeeping(row,policy))))return[];return indices;}
export function classifyNativeBatch(body,policy){const rows=Array.isArray(body)?body:[body];return rows.map(row=>{const query=String(row?.query??''),operationName=typeof row?.operationName==='string'?row.operationName:null,kind=query.match(/^\s*(query|subscription|mutation)\b/)?.[1]??'unknown',hash=documentHash(query),variables=row?.variables??{},variableKeys=Object.keys(variables).sort(),inputKeys=Object.keys(variables.input??{}).sort(),app=['desktop','mobile'].includes(String(variables.app).toLowerCase())?String(variables.app).toLowerCase():'other',editing=typeof variables.editing==='boolean'?variables.editing:null,ticketIdMatches=[variables.ticketId,variables.id,variables.objectId].includes('gid://zammad/Ticket/'+policy?.ticketId);if(admitNativeRead(row))return{operationName,kind,documentHash:hash,variableKeys,inputKeys,app,editing,ticketIdMatches,admitted:true,reason:'read'};if(admitNativeBookkeeping(row,policy))return{operationName,kind,documentHash:hash,variableKeys,inputKeys,app,editing,ticketIdMatches,admitted:true,reason:'owned-bookkeeping'};const pinned=!!policy?.documentHashes?.[operationName]?.includes(hash);const reason=kind==='mutation'?(pinned?'bookkeeping-scope-rejected':'document-not-pinned'):!operationName?'operation-name-missing':/\bmutation\b/.test(query)?'contains-mutation-token':'read-operation-mismatch';return{operationName,kind,documentHash:hash,variableKeys,inputKeys,app,editing,ticketIdMatches,admitted:false,reason};});}
