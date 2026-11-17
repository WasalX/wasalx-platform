import assert from 'node:assert/strict';
// Attach inside createWahaSimulation; emit owns state admission, HMAC and immutable replay bytes.
export function attachMutationControls(server,{emit,emissions,now,groupId,directChatIds,phone}) {
  server.emitMutation=({eventId,kind,messageId,targetMessageId,chatId,participant,text})=>{
    assert(['edited','revoked','reaction'].includes(kind));
    assert(chatId===groupId||directChatIds.includes(chatId));
    assert(/^\d{6,20}@(c\.us|lid)$/.test(participant));
    assert(typeof messageId==='string'&&messageId.length<=512&&messageId.startsWith(`false_${chatId}_`));
    assert(typeof targetMessageId==='string'&&targetMessageId.length<=512&&/^(true|false)_/.test(targetMessageId));
    assert(targetMessageId.split('_')[1]===chatId,'Target must be in the admitted chat');
    assert.notEqual(messageId,targetMessageId);
// eslint-disable-next-line no-control-regex -- Intentionally reject unsafe control bytes at the simulator boundary.
    if(kind==='edited')assert(typeof text==='string'&&text.length<=4096&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text));
    if(kind==='reaction')assert(typeof text==='string'&&Array.from(text).length<=16&&!/\s/.test(text));
    const timestamp=emissions.get(eventId)?.timestamp??now();
    const action={id:messageId,timestamp:Math.floor(timestamp/1000),from:chatId,fromMe:false,source:'app',to:phone+'@c.us',participant,body:kind==='edited'?text:'',hasMedia:false,mediaUrl:'',ack:1,ackName:'SERVER'};
    const payload=kind==='edited'?{...action,editedMessageId:targetMessageId}:kind==='revoked'?{revokedMessageId:targetMessageId,after:action}:{...action,reaction:{text,messageId:targetMessageId}};
    return emit(eventId,`message.${kind}`,payload,timestamp);
  };
}
