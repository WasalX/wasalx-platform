import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{assertOpenWindowCorrelation}from'../scripts/release/simulation-meta-open-window.mjs';
const expected={deliveryId:'d',externalMessageId:'m',recipient:'12025550173'},delivery={id:'d',state:'READ',attempts:1,external_message_id:'m',external_chat_id:'12025550173',text_sha256:createHash('sha256').update('message').digest('hex')},receipt={id:'m',type:'text',to:'12025550173',body:{text:{body:'message'}}};
test('existing read receipt proves one unchanged text delivery',()=>assert.equal(assertOpenWindowCorrelation([delivery],[receipt],expected),receipt));
test('extra receipt cannot qualify',()=>assert.throws(()=>assertOpenWindowCorrelation([delivery],[receipt,receipt],expected)));
test('wrong body cannot qualify',()=>assert.throws(()=>assertOpenWindowCorrelation([delivery],[{...receipt,body:{text:{body:'wrong'}}}],expected)));
