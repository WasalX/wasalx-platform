import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openPortalTicket} from './simulation-portal-operator.mjs';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const replyRequest=(request,origin)=>{
 try{return new URL(request.url()).origin===origin&&new URL(request.url()).pathname==='/api/inbox'&&request.method()==='POST'&&request.postDataJSON()?.operation==='REPLY';}catch{return false;}
};
// A returned receipt proves admission only. Caller must reconcile native/provider outcome.
export async function submitPortalReply(operator,{ticketId:expectedTicketId,ticketNumber,body,internal=false,checkpoint,expectedPreviewText,beforeDispatch=()=>{}}){
 assert(operator?.session&&operator?.page&&typeof operator.verify==='function');
 assert.match(String(ticketNumber),/^[1-9][0-9]{0,15}$/u);
 assert.equal(typeof body,'string');assert(body.trim().length>0&&body.length<=4096);
 assert.equal(typeof internal,'boolean');assert.equal(typeof checkpoint,'function');
 assert.equal(typeof beforeDispatch,'function');if(expectedTicketId!==undefined)assert.match(String(expectedTicketId),/^[1-9][0-9]{0,15}$/u);if(expectedPreviewText!==undefined){assert.equal(internal,false);assert.equal(typeof expectedPreviewText,'string');}
 const {page}=operator,origin=operator.session.portalOrigin;
 await operator.verify();const opened=await openPortalTicket(operator,{ticketNumber,reload:false});
 assert.match(String(opened?.renderedTicketId??''),/^[1-9][0-9]*$/u);const ticketId=String(opened.renderedTicketId);
 if(expectedTicketId!==undefined)assert.equal(ticketId,String(expectedTicketId),'Opened reply ticket differs from the owned target');
 await page.locator('#inbox-kind').selectOption(internal?'note':'reply');
 await page.locator('#inbox-message').fill(body);let previewRevision=null;
 if(!internal){
  const previewResponse=page.waitForResponse(response=>{try{const input=response.request().postDataJSON();return new URL(response.url()).origin===origin&&input.operation==='PREVIEW'&&String(input.input?.ticket_id)===ticketId&&input.input?.body===body&&input.input?.internal===false;}catch{return false;}},{timeout:15000});
  await page.getByRole('button',{name:'Preview reply',exact:true}).click();const response=await previewResponse;assert(response.ok());
  const preview=await response.json(),input=response.request().postDataJSON().input;
  assert.equal(preview.can_send,true);assert.equal(preview.ticket_updated_at,input.expected_updated_at);previewRevision=preview.ticket_updated_at;assert.match(preview.draft_sha256??'',/^[a-f0-9]{64}$/u);
  assert.equal(typeof preview.text,'string');assert(preview.text.includes(body));
  if(expectedPreviewText!==undefined)assert.equal(preview.text,expectedPreviewText,'Visible reply preview differs from the exact provider wire');
  await page.locator('.wx-ticket-preview').getByText(preview.text,{exact:true}).waitFor({state:'visible'});
 }
 const submit=page.getByRole('button',{name:internal?'Add note':'Send reply',exact:true});
 assert.equal(await submit.count(),1);assert(await submit.isEnabled());
 await operator.verify();
 await checkpoint({phase:'intent',step:'portal-reply',ticketNumber:String(ticketNumber),internal,bodySha256:createHash('sha256').update(body).digest('hex'),at:new Date().toISOString()});
 const requests=[];let routeError,failRoute;const routeFailed=new Promise(resolve=>{failRoute=resolve;});
 const checkInput=input=>{assert.match(input?.operation_id??'',UUID);assert.equal(String(input.ticket_id),ticketId);assert.equal(input.body,body);assert.equal(input.internal,internal);if(previewRevision!==null)assert.equal(input.expected_updated_at,previewRevision);};
 const handler=async route=>{const request=route.request();if(!replyRequest(request,origin))return route.fallback();const input=request.postDataJSON().input;requests.push(input);
  try{assert.equal(requests.length,1,'Reply submitted more than once');checkInput(input);await beforeDispatch(input);await route.continue();}
  catch(error){routeError=error;failRoute({routeError:error});await route.abort().catch(()=>{});}
 };
 await page.route('**/api/inbox',handler);
 let responseListener,responseTimer;const observed=new Promise(resolve=>{responseListener=response=>{if(replyRequest(response.request(),origin))resolve({response});};page.on('response',responseListener);responseTimer=setTimeout(()=>resolve({unknown:true}),15000);});
 let clicked=false,received;
 try{clicked=true;await submit.click();received=await Promise.race([observed,routeFailed]);}
 catch{received=await Promise.race([observed,routeFailed]);}
 finally{clearTimeout(responseTimer);page.off('response',responseListener);await page.unroute('**/api/inbox',handler);}
 const input=requests[0],operationId=UUID.test(input?.operation_id??'')?input.operation_id:undefined;
 const operationIds=[...new Set(requests.map(value=>value.operation_id).filter(value=>UUID.test(value??'')))];
 await checkpoint({phase:'submitted',step:'portal-reply',ticketNumber:String(ticketNumber),operationId:operationId??null,operationIds,requestCount:requests.length,at:new Date().toISOString()});
 await operator.verify();
 if(routeError)throw Object.assign(routeError,{...(operationId?{operationId}:{}),operationIds});
 assert.equal(clicked,true);assert(requests.length<=1,'Reply submitted more than once');
 if(input)checkInput(input);
 if(!input||!received?.response?.ok())return{state:'UNKNOWN',...(operationId?{operationId}:{})};
 let result;try{result=await received.response.json();}catch{return{state:'UNKNOWN',operationId};}
 if(result.state!=='APPLIED'||result.operation_id!==operationId||String(result.ticket_id)!==String(input.ticket_id)||!/^[1-9][0-9]*$/u.test(String(result.article_id)))return{state:'UNKNOWN',operationId};
 return{state:'APPLIED',operationId,ticketId:String(result.ticket_id),articleId:String(result.article_id)};
}
