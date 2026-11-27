import {attachMutationControls} from './waha-mutation-controls.mjs';
import assert from 'node:assert/strict';
import {startSimulationControl} from './waha-simulation-control.mjs';
import {readFileSync,lstatSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Only the owned ingress acknowledgement is retained; arbitrary response text is discarded.
async function ingressReceipt(response){
  if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();return;}
  if(!response.body)return;
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();return;}chunks.push(Buffer.from(value));}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(value&&typeof value.accepted==='boolean'&&typeof value.duplicate==='boolean'&&typeof value.event_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.event_id))return{accepted:value.accepted,duplicate:value.duplicate,event_id:value.event_id};
  }catch{/* A missing or malformed receipt never changes the observed HTTP status. */}
  finally{reader.releaseLock();}
}

export function createWahaSimulation({additionalDiscoveryGroupIds=[],participantRoster=[],inboundMediaFixtures=[],mediaBaseUrl, stateFile,apiKey,session,groupId,phone,version,outcomes=[],initialState="WORKING",healthStatus="ok",directChatIds=[],now=()=>Date.now(),webhookDestinations=[],isolatedWebhookMapping=false,webhookTimeoutMs=5000,initialExists=true,qrFixtures=[],qrDurationsMs=[60000,20000,20000,20000,20000,20000]}) {
  assert(typeof apiKey==='string'&&apiKey.length>=16);
// eslint-disable-next-line no-control-regex -- Intentionally reject unsafe control bytes at the simulator boundary.
  assert(typeof session==='string'&&session.length>0&&session.length<=128&&!/[\x00-\x1f\x7f]/.test(session));assert(/^\d+@g\.us$/.test(groupId));assert(/^\d{6,20}$/.test(phone));assert(version);
  assert(outcomes.every(x=>['success','rate-limit','disconnect-before-acceptance','disconnect-after-acceptance'].includes(x)));
  assert(['WORKING','STOPPED','STARTING','SCAN_QR_CODE','FAILED'].includes(initialState));
  assert(directChatIds.every(id=>/^\d{6,20}@(c\.us|lid)$/.test(id)));
  assert(Array.isArray(participantRoster)&&participantRoster.length<=1024);
  assert(Array.isArray(additionalDiscoveryGroupIds)&&additionalDiscoveryGroupIds.length<=8);
  assert(new Set(additionalDiscoveryGroupIds).size===additionalDiscoveryGroupIds.length);
  for(const id of additionalDiscoveryGroupIds)assert(typeof id==='string'&&/^\d+@g\.us$/.test(id)&&id!==groupId);
  additionalDiscoveryGroupIds=[...additionalDiscoveryGroupIds];
  const discoveryGroups=[groupId,...additionalDiscoveryGroupIds];
  const rosterIds=new Set(),roster=participantRoster.map(row=>{
    assert(row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).every(k=>['JID','LID','PhoneNumber','DisplayName'].includes(k)));
    const id=row.JID??row.LID;assert(typeof id==='string'&&/^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$/.test(id));
    assert(!(row.JID&&row.LID)&&!rosterIds.has(id));rosterIds.add(id);
    assert(row.PhoneNumber===undefined||(typeof row.PhoneNumber==='string'&&/^[1-9][0-9]{5,14}(?:@(c\.us|s\.whatsapp\.net))?$/.test(row.PhoneNumber)));
// eslint-disable-next-line no-control-regex -- Intentionally reject unsafe control bytes at the simulator boundary.
    assert(row.DisplayName===undefined||(typeof row.DisplayName==='string'&&row.DisplayName.length<=160&&!/[\x00-\x1f\x7f]/.test(row.DisplayName)));
    return {...row};
  });
  assert(qrFixtures.length<=6&&qrDurationsMs.length>=qrFixtures.length&&qrDurationsMs.every(n=>Number.isSafeInteger(n)&&n>0));
  for(const qr of qrFixtures)assert(Buffer.isBuffer(qr)&&qr.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')));
  assert(['ok','error'].includes(healthStatus));
  const mediaFixtures=new Map();assert(inboundMediaFixtures.length<=8);if(inboundMediaFixtures.length){const u=new URL(mediaBaseUrl);assert(u.protocol==='http:'&&['waha-gows','127.0.0.1'].includes(u.hostname)&&u.pathname==='/'&&!u.search&&!u.username&&!u.password);}
  for(const item of inboundMediaFixtures){assert(/^[a-zA-Z0-9_-]{1,40}$/.test(item.id)&&!mediaFixtures.has(item.id));assert(['image/png','image/jpeg','application/pdf','text/plain'].includes(item.mimetype));assert(typeof item.filename==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(item.filename));assert(Buffer.isBuffer(item.bytes)&&item.bytes.length>0&&item.bytes.length<=1048576);mediaFixtures.set(item.id,{...item,bytes:Buffer.from(item.bytes)});}
  const startedAt=now();
  let exists=initialExists,config={},qrEpoch=now();
  const readBody=async req=>{let length=0,chunks=[];for await(const c of req){length+=c.length;if(length>65536)throw Error('body limit');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');};
  let state=initialState;const messages=[];
  const snapshot=()=>({name:session,status:state,config,engine:{engine:'GOWS'},me:state==='WORKING'?{id:phone+'@c.us',pushName:'Simulation bot'}:null});
  let receivedSends=0;const receipts=[],pending=[...outcomes];const hash=x=>createHash('sha256').update(x).digest('hex');
  const arms=[];
  const emissions=new Map();let persistenceFailed=false,lastPersisted;
  const identity={groupId,phone,version,...(additionalDiscoveryGroupIds.length?{additionalDiscoveryGroupIds}:{}),...(roster.length?{participantRoster:roster}:{})};
  function checkPrivate(path,directory=false){const st=lstatSync(path);assert(!st.isSymbolicLink()&&(directory?st.isDirectory():st.isFile()));assert((st.mode&0o077)===0);if(process.getuid)assert.equal(st.uid,process.getuid());return st;}
  if(stateFile){
    assert(isAbsolute(stateFile));checkPrivate(dirname(stateFile),true);
    try{const st=checkPrivate(stateFile);assert(st.size<=16*1024*1024);const data=JSON.parse(readFileSync(stateFile,'utf8'));assert.equal(data.schema,1);assert.deepEqual(data.identity,identity);assert(typeof data.session==='string'&&typeof data.exists==='boolean');assert(['WORKING','STOPPED','STARTING','SCAN_QR_CODE','FAILED'].includes(data.state));assert(Number.isSafeInteger(data.receivedSends)&&data.receivedSends>=0);assert(Array.isArray(data.messages)&&Array.isArray(data.receipts)&&Array.isArray(data.pending)&&Array.isArray(data.emissions));
// eslint-disable-next-line no-control-regex -- Intentionally reject unsafe control bytes at the simulator boundary.
      assert(data.session.length>0&&data.session.length<=128&&!/[\x00-\x1f\x7f]/.test(data.session));assert(data.config&&typeof data.config==='object'&&!Array.isArray(data.config));assert(Number.isSafeInteger(data.qrEpoch)&&data.qrEpoch>=0);assert(data.pending.every(x=>['success','rate-limit','disconnect-before-acceptance','disconnect-after-acceptance'].includes(x)));assert(data.receipts.every((r,i)=>r&&typeof r.id==='string'&&r.sequence===i+1&&/^[a-f0-9]{64}$/.test(r.textSha256)));assert(data.messages.length===data.receipts.length&&data.messages.every((m,i)=>m&&m.id===data.receipts[i].id&&typeof m.body==='string'));assert(data.receivedSends>=data.receipts.length);assert(new Set(data.emissions.map(e=>e[0])).size===data.emissions.length);for(const [id,e] of data.emissions){assert(/^evt_[0-9a-hjkmnp-tv-z]{26}$/.test(id));assert(typeof e.input==='string'&&Number.isSafeInteger(e.timestamp)&&typeof e.bytes==='string');const b=Buffer.from(e.bytes,'base64');assert.equal(b.toString('base64'),e.bytes);const envelope=JSON.parse(b.toString('utf8'));assert.equal(envelope.id,id);assert.equal(envelope.timestamp,e.timestamp);assert.equal(envelope.session,data.session);assert.equal(JSON.stringify({event:envelope.event,payload:envelope.payload}),e.input);if(e.results!==undefined)assert(Array.isArray(e.results));}
      assert(Array.isArray(data.arms??[]));for(const a of data.arms??[]){assert(a&&typeof a.id==='string'&&typeof a.session==='string'&&typeof a.chatId==='string'&&/^[a-f0-9]{64}$/.test(a.textSha256)&&['rate-limit','disconnect-before-acceptance','disconnect-after-acceptance'].includes(a.outcome)&&['ARMED','CONSUMED'].includes(a.state));}assert((data.arms??[]).filter(a=>a.state==='ARMED').length<=1);arms.push(...(data.arms??[]));
      ({session,exists,config,state,qrEpoch,receivedSends}=data);messages.push(...data.messages);receipts.push(...data.receipts);pending.splice(0,pending.length,...data.pending);for(const [id,e] of data.emissions)emissions.set(id,{...e,bytes:Buffer.from(e.bytes,'base64')});lastPersisted=JSON.stringify(data);
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  function persist(){
    assert(!persistenceFailed,'Persistence previously failed');if(!stateFile)return;
    try{checkPrivate(dirname(stateFile),true);try{checkPrivate(stateFile);}catch(e){if(e.code!=='ENOENT')throw e;}
      const bytes=JSON.stringify({schema:1,identity,session,exists,config,state,qrEpoch,receivedSends,messages,receipts,pending,arms,emissions:[...emissions].map(([id,e])=>[id,{...e,bytes:e.bytes.toString('base64')}])});assert(Buffer.byteLength(bytes)<=16*1024*1024);if(bytes===lastPersisted)return;
      const temporary=stateFile+'.tmp-'+process.pid+'-'+Date.now();const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,stateFile);const dir=openSync(dirname(stateFile),'r');try{fsyncSync(dir);}finally{closeSync(dir);}lastPersisted=bytes;
    }catch(error){persistenceFailed=true;throw error;}
  }
  const server=createServer(async(req,res)=>{
    if(persistenceFailed){res.destroy();return;}
    const json=(status,value)=>{persist();res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    const supplied=Buffer.from(String(req.headers['x-api-key']??'')),expected=Buffer.from(apiKey);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'unauthorized'}));return;}
    try {
      const url=new URL(req.url,'http://simulation');
      if(req.method==='GET'&&url.pathname.startsWith('/api/files/synthetic/')){const item=mediaFixtures.get(url.pathname.slice('/api/files/synthetic/'.length));if(!item||url.search){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':item.mimetype,'content-length':item.bytes.length,'cache-control':'no-store'});res.end(item.bytes);return;}

      if(req.method==='POST'&&url.pathname==='/api/sessions') {
        const body=await readBody(req);
        if(exists)return json(422,{statusCode:422,message:'Session already exists',error:'Unprocessable Entity'});
// eslint-disable-next-line no-control-regex -- Intentionally reject unsafe control bytes at the simulator boundary.
        if(typeof body.name!=='string'||!body.name.length||body.name.length>128||/[\x00-\x1f\x7f]/.test(body.name)||body.start!==undefined&&typeof body.start!=='boolean'||body.apps?.length)return json(400,{error:'unsupported-simulation-create'});
        session=body.name;config=body.config??{};exists=true;state=body.start===false?'STOPPED':'STARTING';qrEpoch=now();return json(201,snapshot());
      }
      if(url.pathname==='/api/sessions'&&req.method==='GET')return json(200,exists?[snapshot()]:[]);
      if(!exists&&!['/api/server/version','/api/server/status','/health'].includes(url.pathname)&&url.pathname!=='/__simulation/receipts')return json(404,{error:'simulation-session-absent'});
      if(req.method==='DELETE'&&url.pathname==='/api/sessions/'+encodeURIComponent(session)){exists=false;state='STOPPED';return json(200,{});}
      if(req.method==='GET'&&url.pathname==='/api/'+encodeURIComponent(session)+'/auth/qr') {
        if(state!=='SCAN_QR_CODE'||!qrFixtures.length)return json(409,{error:'simulation-qr-unavailable'});
        if(url.searchParams.get('format')!=='image')return json(400,{error:'unsupported-simulation-qr-format'});
        let elapsed=now()-qrEpoch,index=0;while(index<qrFixtures.length&&elapsed>=qrDurationsMs[index])elapsed-=qrDurationsMs[index++];
        if(index>=qrFixtures.length){state='FAILED';return json(409,{error:'simulation-qr-exhausted'});}
        const image=qrFixtures[index];
        if(String(req.headers.accept).includes('application/json'))return json(200,{mimetype:'image/png',data:image.toString('base64')});
        res.writeHead(200,{'content-type':'image/png'});res.end(image);return;
      }
      if(req.method==='GET') {
        if(url.pathname==='/health')return json(healthStatus==='ok'?200:503,{status:healthStatus,info:{},error:{},details:{}});
        if(url.pathname==='/api/server/status')return json(200,{startTimestamp:startedAt,uptime:Math.max(0,now()-startedAt),worker:{id:'simulation'}});
        if(url.pathname==='/api/server/version')return json(200,{version,engine:'GOWS'});
        if(url.pathname===`/api/sessions/${encodeURIComponent(session)}`)return json(200,snapshot());
        if(url.pathname===`/api/sessions/${encodeURIComponent(session)}/me`&&state!=='WORKING')return json(409,{error:'session-not-working'});
        if(url.pathname===`/api/sessions/${encodeURIComponent(session)}/me`)return json(200,{id:phone+'@c.us',pushName:'Simulation bot'});
        if(url.pathname===`/api/${encodeURIComponent(session)}/groups`)return json(200,discoveryGroups.slice(Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('offset')??0)+Number(url.searchParams.get('limit')??100)).map(id=>({JID:id,Name:id===groupId?'Simulation group':'Simulation shared group',Participants:id===groupId?roster:[],ParticipantCount:id===groupId?roster.length:0})));
        if(url.pathname==='/api/contacts/all'&&url.searchParams.get('session')===session)return json(200,[]);
        if(url.pathname==='/__simulation/receipts')return json(200,{evidenceClass:'simulated-provider',receivedSends,receipts});
      }
      if(req.method==='POST'&&url.pathname.startsWith('/api/sessions/'+encodeURIComponent(session)+'/')) {
        const action=url.pathname.split('/').at(-1);
        if(!['start','stop','restart','logout'].includes(action))return json(404,{error:'unsupported-lifecycle'});
        state=['stop','logout'].includes(action)?'STOPPED':'STARTING';qrEpoch=now();return json(201,snapshot());
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/'+encodeURIComponent(session)+'/chats/')) {
        const parts=url.pathname.split('/'),chat=decodeURIComponent(parts[4]??'');
        if(parts[5]!=='messages'||!(chat===groupId||directChatIds.includes(chat)))return json(404,{error:'unknown-chat'});
        const found=messages.filter(m=>m.to===chat);
        if(parts[6]){const row=found.find(m=>m.id===decodeURIComponent(parts[6]));return json(row?200:404,row??{error:'unknown-message'});}
        const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??100);
        if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(400,{error:'invalid-pagination'});
        return json(200,found.slice().reverse().slice(offset,offset+limit));
      }
      if(req.method==='POST'&&['/api/sendSeen','/api/startTyping'].includes(url.pathname)){
        const body=await readBody(req);
        if(state!=='WORKING')return json(409,{error:'session-not-working'});
        const read=url.pathname==='/api/sendSeen';
        assert.deepEqual(Object.keys(body).sort(),read?['chatId','messageIds','session']:['chatId','session']);
        assert.equal(body.session,session);assert(directChatIds.includes(body.chatId));
        if(read){
          assert(Array.isArray(body.messageIds)&&body.messageIds.length===1);
          const id=body.messageIds[0];
          assert(typeof id==='string'&&id.startsWith('false_'+body.chatId+'_'));
        }
        res.writeHead(201);res.end();return;
      }
      if(req.method==='POST'&&['/api/sendText','/api/sendImage','/api/sendFile','/api/sendVideo','/api/sendVoice'].includes(url.pathname)) {
        let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>(url.pathname==='/api/sendText'?65536:8*1024*1024))return json(413,{error:'too-large'});chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let media;
        if(url.pathname!=='/api/sendText'){
          assert(body.file&&typeof body.file==='object'&&!Array.isArray(body.file));assert(Object.keys(body.file).every(k=>['mimetype','filename','data'].includes(k)));
          assert(typeof body.file.data==='string'&&typeof body.file.mimetype==='string'&&typeof body.file.filename==='string'&&body.file.filename.length<=255);
          const data=Buffer.from(body.file.data,'base64');assert(data.length>0&&data.length<=5*1024*1024&&data.toString('base64')===body.file.data);
          const mime=body.file.mimetype.toLowerCase();assert(url.pathname==='/api/sendFile'||url.pathname==='/api/sendImage'&&mime.startsWith('image/')||url.pathname==='/api/sendVideo'&&mime==='video/mp4'||url.pathname==='/api/sendVoice'&&mime.startsWith('audio/'));
          assert(body.caption===undefined||typeof body.caption==='string');assert(Object.keys(body).every(k=>['session','chatId','file','caption','reply_to','convert'].includes(k)));
          if(url.pathname==='/api/sendVideo')assert.equal(body.convert,false);else if(url.pathname==='/api/sendVoice')assert.equal(body.convert,true);else assert(body.convert===undefined);
          media={mimetype:body.file.mimetype,filename:body.file.filename,data:body.file.data,sha256:hash(data),bytes:data.length,route:url.pathname,conversion:'NOT_SIMULATED'};
          body.text=body.caption??'';delete body.file;delete body.caption;delete body.convert;
        }
        if(body.session!==session||!(body.chatId===groupId||directChatIds.includes(body.chatId))||typeof body.text!=='string'||(!body.text.length&&!media))return json(400,{error:'invalid-target-or-text'});
        if(state!=='WORKING')return json(409,{error:'session-not-working'});
        if(Object.keys(body).some(k=>!['session','chatId','text','reply_to','mentions'].includes(k)))return json(400,{error:'unsupported-send-option'});
        if(body.mentions!==undefined)assert(Array.isArray(body.mentions)&&body.chatId===groupId&&body.mentions.length<=100&&body.mentions.every(x=>typeof x==='string'&&/^[1-9][0-9]{5,19}@(c\.us|lid)$/.test(x)));receivedSends++;const arm=arms.find(a=>!media&&a.state==='ARMED'&&a.session===body.session&&a.chatId===body.chatId&&a.textSha256===hash(body.text));if(arm){arm.state='CONSUMED';arm.consumedSequence=receivedSends;}const outcome=arm?.outcome??pending.shift()??'success';
        if(outcome==='rate-limit'){res.setHeader('retry-after','1');return json(429,{error:'simulated-rate-limit'});}
        if(outcome==='disconnect-before-acceptance'){persist();req.socket.destroy();return;}
        // Deliberately no fake provider idempotency: duplicate sends stay visible.
        const id=`true_${body.chatId}_${hash(String(receipts.length+1)).slice(0,20).toUpperCase()}`;
        messages.push({id,fromMe:true,from:phone+'@c.us',to:body.chatId,body:body.text,timestamp:Math.floor(now()/1000),source:'api',participant:body.chatId.endsWith('@g.us')?phone+'@c.us':'',hasMedia:false,mediaUrl:'',ack:0,ackName:'PENDING'});
        receipts.push({id,sequence:receipts.length+1,textSha256:hash(body.text),replyToSha256:body.reply_to?hash(String(body.reply_to)):null,mentions:body.mentions??[],acceptedAt:new Date().toISOString()});
        if(media){Object.assign(messages.at(-1),{hasMedia:true,mediaUrl:'',media});Object.assign(receipts.at(-1),{mediaSha256:media.sha256,mediaBytes:media.bytes,mediaMimeType:media.mimetype,mediaRoute:media.route});}
        if(outcome==='disconnect-after-acceptance'){persist();req.socket.destroy();return;}
        return json(201,messages.at(-1));
      }
      return json(404,{error:'unsupported-simulation-route'});
    }catch{if(persistenceFailed){res.destroy();return;}return json(400,{error:'invalid-request'});}
  });
  // Simulation control is in-process only; never impersonates a provider route.
  server.armNextSend=input=>{assert(exists&&state==='WORKING');assert(input&&typeof input.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(input.id));assert.equal(input.session,session);assert(input.chatId===groupId||directChatIds.includes(input.chatId));assert(/^[a-f0-9]{64}$/.test(input.textSha256));assert(['rate-limit','disconnect-before-acceptance','disconnect-after-acceptance'].includes(input.outcome));assert(!arms.some(a=>a.id===input.id||a.state==='ARMED'));arms.push({id:input.id,session,chatId:input.chatId,textSha256:input.textSha256,outcome:input.outcome,state:'ARMED'});persist();return {id:input.id,state:'ARMED'};};
  server.readArms=()=>structuredClone(arms);
  server.simulateState=next=>{assert(['WORKING','STOPPED','STARTING','SCAN_QR_CODE','FAILED'].includes(next));state=next;qrEpoch=now();persist();};
  // Explicit isolated destinations only. No webhook network is enabled by default.
  const allowed=new Set(webhookDestinations.map(value=>{
    const u=new URL(value);assert(u.protocol==='http:'&&['127.0.0.1','localhost','control-api'].includes(u.hostname)&&!u.username&&!u.password&&!u.hash);
    return u.href;
  }));
  function webhookDestination(value){
    const u=new URL(value);
    if(allowed.has(u.href))return u.href;
    assert(isolatedWebhookMapping&&u.origin==='https://simulation.invalid'&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/webhooks\/waha\/[A-Za-z0-9_-]{32,256}$/.test(u.pathname),'Unsupported isolated webhook URL');
    return 'http://control-api:3001'+u.pathname;
  }
  async function emit(eventId,event,payload,eventTimestamp){
    assert(/^evt_[0-9a-hjkmnp-tv-z]{26}$/.test(eventId));
    assert(exists && (event === 'session.status' || state === 'WORKING'));
    const input=JSON.stringify({event,payload});let saved=emissions.get(eventId);
    if(saved)assert.equal(saved.input,input,'Event ID cannot change payload');
    else{
      const timestamp=eventTimestamp??now();
      saved={input,timestamp,bytes:Buffer.from(JSON.stringify({id:eventId,timestamp,session,metadata:config.metadata??{},engine:'GOWS',event,payload,environment:{version,engine:'GOWS',tier:'PLUS'},me:state==='WORKING'?{id:phone+'@c.us',pushName:'Simulation bot'}:null}))};
      emissions.set(eventId,saved);
    }
    const targets=(config.webhooks??[]).filter(w=>w.events?.includes(event));
    assert(targets.length>0,'No subscribed webhook');
    for(const w of targets)assert(webhookDestination(w.url)&&typeof w.hmac?.key==='string'&&w.hmac.key.length>=16&&!w.customHeaders?.length,'Unsupported webhook destination/config');
    persist();
    const results=[];
    for(const w of targets){
      const headers={'content-type':'application/json','x-webhook-hmac-algorithm':'sha512','x-webhook-hmac':createHmac('sha512',w.hmac.key).update(saved.bytes).digest('hex'),'x-webhook-timestamp':String(saved.timestamp)};
      const controller = new AbortController();
      // Keep the deadline alive until the receipt body is consumed, even after fetch returns headers.
      const deadline = setTimeout(() => {
        controller.abort(new DOMException('Webhook request timed out', 'TimeoutError'));
      }, webhookTimeoutMs);
      try {
        const response = await fetch(webhookDestination(w.url), {
          method: 'POST', headers, body: saved.bytes, redirect: 'error', signal: controller.signal,
        });
        const receipt = await ingressReceipt(response);
        results.push({ status: response.status, outcome: 'http-response', ...(receipt ? { receipt } : {}) });
      } catch (error) {
        results.push({ status: null, outcome: error?.name === 'TimeoutError' ? 'timeout' : 'network-or-redirect-error' });
      } finally {
        clearTimeout(deadline);
      }
    }
    saved.results=results;persist();
    return {eventId,bodySha256:hash(saved.bytes),results};
  }
  server.emitSessionStatus=({eventId,status})=>{
    assert(['STARTING','SCAN_QR_CODE','WORKING','STOPPED','FAILED'].includes(status));
    assert(/^evt_[0-9a-hjkmnp-tv-z]{26}$/.test(eventId));
    const prior=emissions.get(eventId);const timestamp=prior?.timestamp??now();
    if(!prior){assert(exists);state=status;qrEpoch=timestamp;}
    return emit(eventId,'session.status',{name:session,status,statuses:[{status,timestamp}],data:null},timestamp);
  };
  server.emitInbound=({eventId,messageId,chatId,participant,text,quotedMessageId,mediaFixtureId,notifyName,source='app',fromMe=false})=>{
    assert(['app','api'].includes(source));assert.equal(typeof fromMe,'boolean');
    assert(quotedMessageId===undefined||(typeof quotedMessageId==='string'&&quotedMessageId.length>0&&quotedMessageId.length<=512&&!/[\p{Cc}\p{Cf}]/u.test(quotedMessageId)),'Invalid simulated quoted message ID');
// eslint-disable-next-line no-control-regex -- Intentionally reject unsafe control bytes at the simulator boundary.
    assert(notifyName===undefined||(typeof notifyName==='string'&&notifyName.length<=256&&!/[\x00-\x1f\x7f]/.test(notifyName)));assert(chatId===groupId||directChatIds.includes(chatId));assert(typeof text==='string'&&text.length<=65536);assert(typeof messageId==='string'&&messageId.length<=512);assert(/^\d{6,20}@(c\.us|lid)$/.test(participant));
    const media=mediaFixtureId===undefined?undefined:mediaFixtures.get(mediaFixtureId);assert(mediaFixtureId===undefined||media,'Unknown owned media fixture');const mediaUrl=media?new URL('/api/files/synthetic/'+media.id,mediaBaseUrl).href:'';
    const timestamp=emissions.get(eventId)?.timestamp??now();
    return emit(eventId,'message',{id:messageId,timestamp:Math.floor(timestamp/1000),from:chatId,fromMe,source,to:phone+'@c.us',participant,body:text,...(quotedMessageId!==undefined?{replyTo:quotedMessageId}:{}),...(notifyName!==undefined?{notifyName}:{}),hasMedia:!!media,mediaUrl,...(media?{media:{url:mediaUrl,mimetype:media.mimetype,filename:media.filename}}:{}),ack:1,ackName:'SERVER'},timestamp);
  };
  server.emitAck=({eventId,messageId,chatId,participant,ack})=>{
    assert(chatId===groupId||directChatIds.includes(chatId));assert([-1,0,1,2,3,4].includes(ack));assert(typeof messageId==='string'&&messageId.length<=512);assert(/^\d{6,20}@(c\.us|lid)$/.test(participant));
    return emit(eventId,chatId===groupId?'message.ack.group':'message.ack',{id:messageId,from:phone+'@c.us',to:chatId,participant,fromMe:true,ack,ackName:({'-1':'ERROR',0:'PENDING',1:'SERVER',2:'DEVICE',3:'READ',4:'PLAYED'})[ack]});
  };



  attachMutationControls(server,{emit,emissions,now,groupId,directChatIds,phone});
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const e=process.env,server=createWahaSimulation({additionalDiscoveryGroupIds:JSON.parse(e.WAHA_SIM_ADDITIONAL_DISCOVERY_GROUP_IDS??'[]'),participantRoster:JSON.parse(e.WAHA_SIM_PARTICIPANT_ROSTER??'[]'),mediaBaseUrl:e.WAHA_SIM_MEDIA_BASE_URL,inboundMediaFixtures:JSON.parse(e.WAHA_SIM_MEDIA_FILES??'[]').map(x=>({...x,bytes:readFileSync(x.path)})),stateFile:e.WAHA_SIM_STATE_FILE,apiKey:e.WAHA_API_KEY,session:e.WAHA_SIM_SESSION,groupId:e.WAHA_SIM_GROUP_ID,phone:e.WAHA_SIM_PHONE,version:e.WAHA_SIM_VERSION,directChatIds:JSON.parse(e.WAHA_SIM_DIRECT_CHAT_IDS??'[]'),isolatedWebhookMapping:e.WAHA_SIM_ISOLATED_WEBHOOK_MAPPING==='true',webhookDestinations:JSON.parse(e.WAHA_SIM_WEBHOOK_DESTINATIONS??'[]'),initialExists:e.WAHA_SIM_INITIAL_EXISTS!=='false',qrFixtures:(e.WAHA_SIM_QR_FILES??'').split(',').filter(Boolean).map(path=>readFileSync(path))});
  const control=e.WAHA_SIM_CONTROL_SOCKET?await startSimulationControl(server,e.WAHA_SIM_CONTROL_SOCKET):null;
  server.listen(Number(e.PORT??3000),'0.0.0.0');
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{control?.close();server.close();});
}
