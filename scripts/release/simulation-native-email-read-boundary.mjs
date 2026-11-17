import{admitNativeRead,targetNativeReadIndices,classifyNativeBatch}from'./simulation-native-bookkeeping-policy.mjs';

export function isRetainedTicketQuery(body,ticketId,surface='mobile'){
 if(!body||Array.isArray(body)||!admitNativeRead(body)||body.operationName!==(surface==='mobile'?'ticketWithMentionLimit':'ticket')||!new RegExp('^\\s*query\\s+'+(surface==='mobile'?'ticketWithMentionLimit':'ticket')+'\\b').test(body.query??''))return false;
 const id=body.variables?.ticketId;return typeof id==='string'&&id===`gid://zammad/Ticket/${ticketId}`;
}
export function targetReadIndices(body,ticketId,surface='mobile',policy){
 return targetNativeReadIndices(body,policy,row=>isRetainedTicketQuery(row,ticketId,surface));
}

export function diagnoseTargetRead(body,ticketId,surface,policy){
 const rows=Array.isArray(body)?body:[body],indices=targetReadIndices(body,ticketId,surface,policy);
 return classifyNativeBatch(body,policy).map((row,index)=>({...row,index,batchSize:rows.length,expectedOperation:surface==='mobile'?'ticketWithMentionLimit':'ticket',ticketIdMatches:rows[index]?.variables?.ticketId===`gid://zammad/Ticket/${ticketId}`,target:isRetainedTicketQuery(rows[index],ticketId,surface),injectionAdmitted:indices.includes(index)}));
}
