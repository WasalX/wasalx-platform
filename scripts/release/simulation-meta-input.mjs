import assert from 'node:assert/strict';
export function metaInput({wabaId,phoneId,customer,id,timestamp,kind,text,promptId,choiceId,choiceTitle,location,sender,media}){
 assert([wabaId,phoneId,customer,id].every(x=>typeof x==='string'&&x.length));assert(Number.isSafeInteger(timestamp));
 const identity=sender??{phone:customer};assert(identity&&typeof identity==='object'&&!Array.isArray(identity));
 assert(Object.keys(identity).every(k=>['phone','bsuid','jointContact'].includes(k)));assert(identity.phone||identity.bsuid);
 if(identity.phone!==undefined)assert(typeof identity.phone==='string'&&/^[1-9][0-9]{2,14}$/.test(identity.phone));
 if(identity.bsuid!==undefined)assert(typeof identity.bsuid==='string'&&/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(identity.bsuid));
 if(identity.jointContact!==undefined)assert(typeof identity.jointContact==='boolean');
 if(identity.jointContact)assert(identity.phone&&identity.bsuid);
 const message={id,...(identity.phone?{from:identity.phone}:{}),...(identity.bsuid?{from_user_id:identity.bsuid}:{}),timestamp:String(timestamp),type:kind};
 const contacts=identity.bsuid?[{user_id:identity.bsuid,...(identity.jointContact?{wa_id:identity.phone}:{})}]:undefined;
 if(kind==='text')message.text={body:text};
 else if(kind==='interactive'){assert(promptId&&choiceId&&choiceTitle);message.context={id:promptId};message.interactive={type:'button_reply',button_reply:{id:choiceId,title:choiceTitle}};}
 else if(kind==='location'){assert(Number.isFinite(location?.latitude)&&Number.isFinite(location?.longitude));assert(Math.abs(location.latitude)<=90&&Math.abs(location.longitude)<=180);message.location=location;}
 else if(kind==='image'||kind==='document'){assert(media&&/^SIMMEDIA[1-9][0-9]*$/.test(media.id)&&/^[a-f0-9]{64}$/.test(media.sha256));assert(media.mime_type===(kind==='image'?'image/png':'application/pdf'));message[kind]=media;}
 else throw Error('Unsupported Meta scenario input');
 return{object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phoneId},...(contacts?{contacts}:{}),messages:[message]}}]}]};
}
