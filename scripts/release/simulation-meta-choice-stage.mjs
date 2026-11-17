import assert from 'node:assert/strict';
import {produceMetaChoices} from './simulation-meta-choice-producer.mjs';
export const metaChoiceIds=[
 'direct-automation/choices-location-and-plugin-actions::native-button-click-continues-configured-flow::01',
 'direct-automation/choices-location-and-plugin-actions::location-branch-persists-authoritative-outcome::01',
];
export function assertChoiceExecutions(rows,fixture){
 for(const [label,kind,from,to] of [['choice','CHOICE','choice','location'],['location','LOCATION','location','handoff']]){
  const input=fixture.result.proofs.find(p=>p.label===label);assert(input);
  const found=rows.filter(r=>r.event_inbox_id===input.processed.inboxId);assert.equal(found.length,1,'Exactly one durable '+label+' advance');
  assert.equal(found[0].event_kind,kind);assert.equal(found[0].from_node_id,from);assert.equal(found[0].to_node_id,to);
 }
}
export async function metaChoiceStage(session,args){
 const startedAt=new Date().toISOString();await session.verifyOwner(session.ownerPage);await session.ownerPage.setViewportSize({width:1440,height:1000});
 const f=await produceMetaChoices(session,args),id=f.conversation.id;
 const events=await session.scoped("SELECT id,event_inbox_id,event_kind,from_node_id,to_node_id FROM bot_conversation_events WHERE tenant_id=$1 AND conversation_id=$2 AND safe_metadata ? 'result' ORDER BY id",[session.tenantId,id]);assertChoiceExecutions(events,f);
 const page=session.ownerPage,origin=session.portalOrigin,mutations=[];
 const guard=async route=>{const r=route.request(),u=new URL(r.url());if(u.origin===origin&&u.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push(u.pathname);return route.abort();}return route.fallback();};
 await page.route('**/api/**',guard);let ui;
 try{
  await page.goto(origin+'/app?view=automation');await page.getByRole('tab',{name:'Conversations',exact:true}).click();await page.locator('.bot-conversations').waitFor();
  const catalog=await page.evaluate(async()=>{const r=await fetch('/api/bot-flows/conversations?limit=50',{cache:'no-store'});if(!r.ok)throw Error('Conversation catalog unavailable');return r.json();});
  const target=catalog.items.find(r=>r.id===id);assert(target);
  const row=page.locator('.bot-conversation-list article').filter({hasText:String(target.flow_name)}).filter({hasText:new RegExp('#'+target.zammad_ticket_number+'(?:\\D|$)')}).filter({has:page.locator('header small').filter({hasText:new RegExp('v'+target.version+'$')})});assert.equal(await row.count(),1);assert(await row.isVisible());
  const path='/api/bot-flows/conversations/'+id+'/events';const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='GET');await row.getByRole('button',{name:'View execution history',exact:true}).click();const response=await pending;assert.equal(response.status(),200);const rendered=await response.json();
  for(const event of events)assert.equal(rendered.items.filter(r=>r.id===event.id).length,1);
  const dialog=page.getByRole('dialog');await dialog.locator('.bot-node-list li').first().waitFor();assert.equal(await dialog.locator('.bot-node-list li').count(),rendered.items.length);
  ui={conversationId:id,eventIds:rendered.items.map(r=>r.id),visible:true};await dialog.getByRole('button',{name:'Close execution history',exact:true}).click();
 }catch(e){ui={visible:false,errorClass:e.name,reason:'Conversation history UI assertion failed'};}finally{await page.unroute('**/api/**',guard);assert.deepEqual(mutations,[]);}await session.verifyOwner(page);
 const proofs=metaChoiceIds.map(testId=>({testId,result:ui?.visible?'passed':'failed',startedAt,finishedAt:new Date().toISOString(),contextId:'tenant_owner-en-desktop',proof:{fixture:f,events,ui,evidenceMode:'simulated',boundaryAction:'Signed simulated Meta button_reply and location; no real provider interaction'}}));
 for(const proof of proofs)await session.checkpoint({phase:'meta-choice-proof',...proof});
 return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,proofs,fixture:f};
}
