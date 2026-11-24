import assert from "node:assert/strict";
import test from "node:test";
import { advanceBotFlow, botFlowEntryRoots, resolveBotEntryCommand, directMessageCapabilities, parseBotFlow, resolveBotHandoff, validateBotFlowVariableProvenance } from "../packages/core/src/bot-flow.ts";
import { mediaAssetCatalogPath, mediaUploadSha256 } from "../lib/media-upload.ts";

const flow = {
  schemaVersion: 1,
  name: "Customer support",
  start: "welcome",
  maxSteps: 30,
  nodes: [
    { id: "welcome", type: "choice", prompt: "How can we help?", buttonLabel: "Select", options: [
      { id: "status", label: "Order status", next: "lookup" },
      { id: "agent", label: "Talk to a person", next: "handoff" },
    ] },
    { id: "lookup", type: "action", actionId: "orders.lookup", input: { order_id: "{{message.text}}" }, onSuccess: "answer", onFailure: "handoff" },
    { id: "answer", type: "send_text", text: "Your order is {{action.status}}.", next: "done" },
    { id: "handoff", type: "handoff", target: "FIXED", zammadGroupId: "2", priority: "2 normal", message: "A person will join shortly." },
    { id: "done", type: "end" },
  ],
};

test("accepts a bounded versioned direct-message flow", () => {
  assert.deepEqual(parseBotFlow(flow), flow);
});

test("rejects missing, duplicate, and unreachable graph nodes", () => {
  assert.throws(() => parseBotFlow({ ...flow, start: "missing" }), /start node does not exist/);
  assert.throws(() => parseBotFlow({ ...flow, nodes: [...flow.nodes, flow.nodes[0]] }), /duplicated/);
  assert.throws(() => parseBotFlow({ ...flow, nodes: [...flow.nodes, { id: "unused", type: "end" }] }), /unreachable/);
  assert.throws(() => parseBotFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === "welcome" ? { ...node, options: [...(node.options ?? []), { id: "agent-copy", label: "talk to a person", next: "handoff" }] } : node) }), /choice label .* is duplicated/);
  assert.throws(() => parseBotFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === "welcome" ? { ...node, buttonLabel: "This label is much too long" } : node) }), /button label is invalid/);
});

test("rejects unsafe action identifiers and invalid locations", () => {
  assert.throws(() => parseBotFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === "lookup" ? { ...node, actionId: "https://internal/" } : node) }), /actionId is invalid/);
  assert.throws(() => parseBotFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === "answer" ? { id: "answer", type: "send_location", latitude: 91, longitude: 46.7, next: "done" } : node) }), /latitude is invalid/);
});

test("uses truthful provider capability fallbacks", () => {
  assert.deepEqual(directMessageCapabilities("waha"), { choices: "NUMBERED_TEXT", location: true, metaFlows: false, templates: false, customerServiceWindowSeconds: null });
  assert.deepEqual(directMessageCapabilities("meta"), { choices: "BUTTONS", location: true, metaFlows: false, templates: true, customerServiceWindowSeconds: 86_400 });
});

test("sends approved templates and advances only a matching WhatsApp form response", () => {
  const configured = parseBotFlow({ schemaVersion: 1, name: "Official journey", start: "template", maxSteps: 10, nodes: [
    { id: "template", type: "send_template", templateName: "order_update", languageCode: "en_US", bodyParameters: ["{{action.order}}"], transcriptText: "Order {{action.order}} update sent.", next: "form" },
    { id: "form", type: "whatsapp_flow", flowId: "12345", prompt: "Confirm order", buttonLabel: "Confirm", screen: "ORDER", data: { order_id: "{{action.order}}" }, next: "done" },
    { id: "done", type: "end" },
  ] });
  const waiting = advanceBotFlow(configured, "template", undefined, { "action.order": "ORD-42", "flow.form.token": "token-42" });
  assert.deepEqual(waiting.effects.map((effect) => effect.type), ["send_template", "send_whatsapp_flow"]);
  assert.equal(waiting.currentNodeId, "form");
  assert.throws(() => advanceBotFlow(configured, "form", { type: "flow_response", flowToken: "wrong", data: {} }, { "flow.form.token": "token-42" }), /response token is invalid/);
  assert.equal(advanceBotFlow(configured, "form", { type: "flow_response", flowToken: "token-42", data: { accepted: "true" } }, { "flow.form.token": "token-42" }).state, "RESOLVED");
});

test("advances automatic nodes and stops durably at a customer choice", () => {
  const result = advanceBotFlow(parseBotFlow({
    schemaVersion: 1,
    name: "Menu",
    start: "hello",
    maxSteps: 10,
    nodes: [
      { id: "hello", type: "send_text", text: "Welcome", next: "menu" },
      { id: "menu", type: "choice", prompt: "Choose", options: [{ id: "agent", label: "Talk to a person", next: "handoff" }] },
      { id: "handoff", type: "handoff", target: "CLIENT_PRIMARY", priority: "2 normal" },
    ],
  }), "hello");
  assert.equal(result.state, "WAITING");
  assert.equal(result.currentNodeId, "menu");
  assert.deepEqual(result.effects.map((effect) => effect.type), ["send_text", "send_choices"]);
});

test("renders a configured list button label", () => {
  const result = advanceBotFlow(parseBotFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === "welcome" ? { ...node, buttonLabel: "View {{action.kind}}" } : node) }), "welcome", undefined, { "action.kind": "orders" });
  assert.equal(result.effects[0]?.type, "send_choices");
  if (result.effects[0]?.type === "send_choices") assert.equal(result.effects[0].buttonLabel, "View orders");
});

test("matches rendered choice labels and rejects rendered collisions", () => {
  const templated = parseBotFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === "welcome" ? { ...node, options: [
    { id: "status", label: "Order {{action.kind}}", next: "lookup" },
    { id: "agent", label: "Talk to a person", next: "handoff" },
  ] } : node) });
  assert.equal(advanceBotFlow(templated, "welcome", { type: "choice", choiceId: "Order status" }, { "action.kind": "status", "message.text": "123" }).currentNodeId, "lookup");
  assert.equal(advanceBotFlow(templated, "welcome", { type: "text", text: "  ORDER ＳＴＡＴＵＳ  " }, { "action.kind": "status", "message.text": "123" }).currentNodeId, "lookup");
  const colliding = parseBotFlow({ ...flow, nodes: flow.nodes.map((node) => node.id === "welcome" ? { ...node, options: [
    { id: "first", label: "Order {{action.first}}", next: "lookup" },
    { id: "second", label: "Order {{action.second}}", next: "handoff" },
  ] } : node) });
  assert.throws(() => advanceBotFlow(colliding, "welcome", undefined, { "action.first": "status", "action.second": "status" }), /rendered duplicate choice label/);
});

test("provider choice IDs take precedence over a different rendered label", () => {
  const ambiguous = parseBotFlow({ schemaVersion: 1, name: "Choice identity", start: "menu", maxSteps: 5, nodes: [
    { id: "menu", type: "choice", prompt: "Choose", options: [
      { id: "first", label: "second", next: "one" },
      { id: "second", label: "Other", next: "two" },
    ] },
    { id: "one", type: "end" },
    { id: "two", type: "end" },
  ] });
  assert.equal(advanceBotFlow(ambiguous, "menu", { type: "choice", choiceId: "second" }).currentNodeId, "two");
});

test("accepts numbered choice replies and reaches handoff", () => {
  const menu = parseBotFlow({
    schemaVersion: 1,
    name: "Menu",
    start: "menu",
    maxSteps: 10,
    nodes: [
      { id: "menu", type: "choice", prompt: "Choose", options: [{ id: "agent", label: "Talk to a person", next: "handoff" }] },
      { id: "handoff", type: "handoff", target: "CLIENT_ESCALATION", priority: "3 high", message: "Connecting you now." },
    ],
  });
  const result = advanceBotFlow(menu, "menu", { type: "text", text: "1" });
  assert.equal(result.state, "HANDOFF");
  assert.equal(result.effects[0]?.type, "handoff");
  assert.equal(advanceBotFlow(menu, "menu", { type: "choice", choiceId: "Talk to a person" }).state, "HANDOFF");
  const effect=result.effects[0];assert.equal(effect?.type,"handoff");
  if(effect?.type==="handoff"){
    const escalationRoute={versionId:"route-v1",status:"MATCHED",clientId:"acme",matchedBy:"EMAIL",escalationGroupId:"9",escalationOwnerId:"14"} as const;
    assert.deepEqual(resolveBotHandoff(effect,"7","12",escalationRoute),{groupId:"9",ownerId:"14"});
    assert.deepEqual(resolveBotHandoff(effect,"7","12"),{groupId:"7",ownerId:"12"});
  }
});

test("normalizes legacy fixed handoff nodes and rejects unknown targets",()=>{
  const legacy=parseBotFlow({...flow,nodes:flow.nodes.map(node=>node.id==="handoff"?{...node,target:undefined}:node)});
  assert.equal(legacy.nodes.find(node=>node.type==="handoff")?.type,"handoff");
  assert.equal(legacy.nodes.find(node=>node.type==="handoff"&&node.target==="FIXED")?.zammadGroupId,"2");
  assert.throws(()=>parseBotFlow({...flow,nodes:flow.nodes.map(node=>node.id==="handoff"?{...node,target:"UNKNOWN"}:node)}),/handoff target is invalid/);
});

test("fails closed on a configured automatic loop", () => {
  const loop = parseBotFlow({ schemaVersion: 1, name: "Loop", start: "again", maxSteps: 2, nodes: [{ id: "again", type: "send_text", text: "Again", next: "again" }] });
  assert.throws(() => advanceBotFlow(loop, "again"), /maximum step budget/);
});

test("renders only explicit action and response variables", () => {
  const action=advanceBotFlow(parseBotFlow(flow),"lookup",undefined,{"message.text":"ORD-42"});
  assert.deepEqual(action.effects[0],{type:"action",nodeId:"lookup",actionId:"orders.lookup",input:{order_id:"ORD-42"},onSuccess:"answer",onFailure:"handoff"});
  const answer=advanceBotFlow(parseBotFlow(flow),"answer",undefined,{"action.status":"shipped"});
  assert.equal(answer.effects[0]?.type,"send_text");
  assert.equal(answer.effects[0]?.type==="send_text"?answer.effects[0].text:"","Your order is shipped.");
  assert.throws(()=>advanceBotFlow(parseBotFlow(flow),"answer"),/action.status is unavailable/);
});

test("action response variables are available only on proven success paths",()=>{
  const actionOutputs=new Map([["orders.lookup",["action.status"]]]);
  assert.doesNotThrow(()=>validateBotFlowVariableProvenance(parseBotFlow(flow),actionOutputs));
  const failureUsesResponse={...flow,nodes:flow.nodes.map(node=>node.id==="handoff"?{id:"handoff",type:"send_text",text:"Lookup failed after {{action.status}}",next:"done"}:node)};
  assert.throws(()=>validateBotFlowVariableProvenance(parseBotFlow(failureUsesResponse),actionOutputs),/handoff uses unavailable variable action\.status/);
  const joined={schemaVersion:1,name:"Joined",start:"lookup",maxSteps:10,nodes:[
    {id:"lookup",type:"action",actionId:"orders.lookup",input:{order_id:"{{message.text}}"},onSuccess:"joined",onFailure:"joined"},
    {id:"joined",type:"send_text",text:"Status {{action.status}}",next:"done"},
    {id:"done",type:"end"},
  ]};
  assert.throws(()=>validateBotFlowVariableProvenance(parseBotFlow(joined),actionOutputs),/joined uses unavailable variable action\.status/);
  assert.throws(()=>validateBotFlowVariableProvenance(parseBotFlow(flow),new Map()),/Bot action orders\.lookup is unavailable/);
});

test("direct media nodes keep immutable asset identity and safely render captions",()=>{
  const assetId="6f4fe8f1-67bb-4a06-945a-b6036d94fa92";
  const configured=parseBotFlow({schemaVersion:1,name:"Media",start:"media",maxSteps:5,nodes:[
    {id:"media",type:"send_media",assetId,caption:"Order {{message.text}}",next:"done"},
    {id:"done",type:"end"},
  ]});
  assert.deepEqual(advanceBotFlow(configured,"media",undefined,{"message.text":"42"}).effects[0],{type:"send_media",nodeId:"media",assetId,caption:"Order 42"});
  assert.throws(()=>parseBotFlow({...configured,nodes:[{id:"media",type:"send_media",assetId:"https://example.test/file",next:"done"},{id:"done",type:"end"}]}),/media asset is invalid/);
  assert.throws(()=>advanceBotFlow(configured,"media",undefined,{"message.text":"x".repeat(1_025)}),/rendered caption is too large/);
});

test("media upload identity distinguishes equal metadata with different bytes",async()=>{
  const first=new Blob(["aa"],{type:"text/plain"});const second=new Blob(["bb"],{type:"text/plain"});
  assert.equal(first.size,second.size);assert.equal(first.type,second.type);
  assert.notEqual(await mediaUploadSha256(first),await mediaUploadSha256(second));
});

test("post-upload catalog refresh preserves old selections beyond the recent page",()=>{
  const oldFirst="64700000-0000-4000-8000-000000000001";
  const oldSecond="64700000-0000-4000-8000-000000000002";
  const uploaded="64700000-0000-4000-8000-000000000003";
  const path=new URL(mediaAssetCatalogPath([oldFirst,oldSecond],uploaded,oldFirst),"https://portal.invalid");
  assert.deepEqual(path.searchParams.getAll("id"),[oldSecond,uploaded]);
});

test("accepts Arabic numeric choices without changing label or choice-ID selection", () => {
  const options = Array.from({ length: 10 }, (_, index) => ({
    id: `option_${index + 1}`, label: index === 0 ? "تحدث مع الدعم" : index === 1 ? "أوقات العمل" : `الخيار ${index + 1}`,
    next: `answer_${index + 1}`,
  }));
  const menu = parseBotFlow({ schemaVersion: 1, name: "Arabic choices", start: "menu", maxSteps: 10, nodes: [
    { id: "menu", type: "choice", prompt: "اختر موضوعاً Order-41", options },
    ...options.map((option, index) => ({ id: option.next, type: "send_text", text: `اختيار ${index + 1}`, next: "done" })),
    { id: "done", type: "end" },
  ] });
  for (const [text, expected] of [["1", 1], ["١", 1], ["۱", 1], ["2", 2], ["٢", 2], ["۲", 2], ["10", 10], ["١٠", 10], ["۱۰", 10], ["١0", 10], ["1۰", 10], [" أوقات العمل ", 2]] as const) {
    const result = advanceBotFlow(menu, "menu", { type: "text", text });
    assert.equal(result.state, "RESOLVED", text);
    const effect = result.effects[0];
    assert.equal(effect?.type, "send_text");
    if (effect?.type === "send_text") assert.equal(effect.text, `اختيار ${expected}`, text);
  }
  assert.equal(advanceBotFlow(menu, "menu", { type: "choice", choiceId: "option_2" }).state, "RESOLVED");
  for (const text of ["0", "٠", "۰", "11", "١١", "۱۱", "٠١", "١.٠", "۱abc", "-٢", "١\u200f", "\u2066٢\u2069", "२"]) {
    const result = advanceBotFlow(menu, "menu", { type: "text", text });
    assert.equal(result.state, "WAITING", text);
    assert.equal(result.currentNodeId, "menu");
    assert.deepEqual(result.effects.map((effect) => effect.type), ["send_choices"]);
  }
});

test("welcome resend is explicit and immutable flow data without changing legacy defaults", () => {
  assert.equal('welcomeResendMinutes' in parseBotFlow(flow), false);
  assert.equal(parseBotFlow({...flow,welcomeResendMinutes:null}).welcomeResendMinutes,null);
  for(const minutes of [1,60,1440])assert.equal(parseBotFlow({...flow,welcomeResendMinutes:minutes}).welcomeResendMinutes,minutes);
  for(const minutes of [0,-1,1441,1.5,'60',true,{},NaN,Infinity])
    assert.throws(()=>parseBotFlow({...flow,welcomeResendMinutes:minutes}),/Welcome resend interval/);
  for(const type of ['send_text','handoff','action']){
    const start=type==='send_text'?{id:'first',type,text:'Hello',next:'welcome'}:type==='handoff'
      ?{id:'first',type,target:'FIXED',zammadGroupId:'2',priority:'2 normal'}
      :{id:'first',type,actionId:'own.action',input:{},onSuccess:'welcome',onFailure:'welcome'};
    const configured={...flow,start:'first',nodes:type==='handoff'?[start]:[start,...flow.nodes]};
    assert.throws(()=>parseBotFlow({...configured,welcomeResendMinutes:60}),/requires a choice start node/);
    assert.equal(parseBotFlow({...configured,welcomeResendMinutes:null}).start,'first');
    assert.equal(parseBotFlow(configured).start,'first');
  }
});


function menuReturnFlow(): Record<string, unknown> & { nodes: Array<Record<string, unknown>> } {
  return {schemaVersion:1,name:'Explicit handoff return',start:'welcome',mainMenuNodeId:'step_1',maxSteps:20,
    keepOpenPolicy:{humanReplyPauseMinutes:120,mainMenu:true,customerResolution:false},nodes:[
      {id:'welcome',type:'choice',prompt:'Welcome',options:[{id:'open',label:'Continue',next:'step_1'}]},
      {id:'step_1',type:'choice',prompt:'Main menu',options:[{id:'agent',label:'Talk to us',next:'handoff'}]},
      {id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal',message:'Our team will follow up',mainMenuReturn:{label:'Main Menu'}}]};
}

test('handoff return is optional, null menu target is retained, old flows stay unchanged',()=>{
  const original=menuReturnFlow();delete original.mainMenuNodeId;delete original.nodes[2].mainMenuReturn;
  const parsed=parseBotFlow(original);assert.equal(Object.hasOwn(parsed,'mainMenuNodeId'),false);
  assert.equal(Object.hasOwn(parsed.nodes[2],'mainMenuReturn'),false);
  assert.equal(parseBotFlow({...original,mainMenuNodeId:null}).mainMenuNodeId,null);
  assert.equal(parseBotFlow(menuReturnFlow()).mainMenuNodeId,'step_1');
});

test('handoff return rejects unknown keys, invalid Unicode length and disabled/absent menu policy',()=>{
  for(const value of [null,[],{},'Main Menu',{label:''},{label:' Menu'},{label:'Menu '},{label:'😀'.repeat(21)},
    {label:7},{label:'Main Menu',next:'step_1'},{label:'Main Menu',action:'close'}]){
    const f=menuReturnFlow();f.nodes[2].mainMenuReturn=value;assert.throws(()=>parseBotFlow(f));
  }
  for(const label of ['القائمة الرئيسية','Main Menu','😀'.repeat(20)]){
    const f=menuReturnFlow();f.nodes[2].mainMenuReturn={label};const handoff=parseBotFlow(f).nodes[2];
    assert.equal(handoff.type,'handoff');if(handoff.type!=='handoff')throw new Error('Expected handoff');
    assert.deepEqual(handoff.mainMenuReturn,{label});
  }
  for(const policy of [undefined,{humanReplyPauseMinutes:120,mainMenu:false,customerResolution:true}])
    assert.throws(()=>parseBotFlow({...menuReturnFlow(),keepOpenPolicy:policy}),/requires the customer Main menu policy/);
});

test('configured menu target must exist and be a choice; it is an explicit graph entry',()=>{
  for(const target of ['',5,false,{},'missing','handoff'])assert.throws(()=>parseBotFlow({...menuReturnFlow(),mainMenuNodeId:target}));
  const f=menuReturnFlow();f.start='handoff';f.nodes=f.nodes.filter(node=>node.id!=='welcome');
  assert.equal(parseBotFlow(f).mainMenuNodeId,'step_1','fresh return root needs no fake handoff edge');
  assert.throws(()=>parseBotFlow({...f,nodes:[...f.nodes,{id:'orphan',type:'end'}]}),/unreachable/);
});

test('main-menu root has only base variables even when normally reached after a successful action',()=>{
  const f=menuReturnFlow();f.start='lookup';f.nodes=f.nodes.filter(node=>node.id!=='welcome');
  f.nodes.unshift({id:'lookup',type:'action',actionId:'orders.lookup',input:{},onSuccess:'step_1',onFailure:'handoff'});
  f.nodes.find(node=>node.id==='step_1')!.prompt='Status {{action.status}}';
  assert.throws(()=>validateBotFlowVariableProvenance(parseBotFlow(f),new Map([['orders.lookup',['action.status']]])),/unavailable variable action.status/);
  f.nodes.find(node=>node.id==='step_1')!.prompt='Request {{message.text}}';
  assert.doesNotThrow(()=>validateBotFlowVariableProvenance(parseBotFlow(f),new Map([['orders.lookup',['action.status']]])));
});

test('six configured terminal handoffs retain one named control without gaining graph actions',()=>{
  const f=menuReturnFlow();const options:Array<{id:string;label:string;next:string}>=[];f.nodes[1].options=options;f.nodes.pop();
  for(let i=0;i<6;i++){const id=`handoff_${i}`;options.push({id:`agent_${i}`,label:`Team ${i}`,next:id});
    f.nodes.push({id,type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal',message:`Team ${i}`,mainMenuReturn:{label:'Main Menu'}});}
  const parsed=parseBotFlow(f);
  for(let i=0;i<6;i++){
    const result=advanceBotFlow(parsed,`handoff_${i}`);assert.equal(result.state,'HANDOFF');assert.equal(result.effects.length,1);
    const effect=result.effects[0];assert.equal(effect.type,'handoff');if(effect.type!=='handoff')throw new Error('Expected handoff');
    assert.deepEqual(effect.mainMenuReturn,{label:'Main Menu'});assert.equal(Object.hasOwn(effect,'options'),false);
    assert.equal(Object.hasOwn(result.effects[0],'next'),false);
  }
});

// Explicit entry-command contracts: synthetic content only.
function entryCommandFlow(enabled = false) {
  return { schemaVersion: 1, name: "Declared command components", start: "menu", maxSteps: 20,
    entryCommands: [
      { id: "special_entry", aliases: ["Special package"], target: "special", enabled },
      { id: "offer_entry", aliases: ["Local delivery"], target: "offer", enabled },
      { id: "north_entry", aliases: ["North area", "منطقة شمالية"], target: "north", enabled },
      { id: "other_entry", aliases: ["Other area"], target: "other", enabled },
    ], nodes: [
      { id: "menu", type: "choice", prompt: "Choose", options: [{ id: "continue", label: "Continue", next: "done" }] },
      { id: "special", type: "send_text", text: "{{message.text}}", next: "done" },
      { id: "offer", type: "choice", prompt: "Select an area", options: [{ id: "north", label: "North area", next: "north" }, { id: "other", label: "Other area", next: "other" }, { id: "back", label: "Back", next: "menu" }] },
      { id: "north", type: "send_text", text: "Synthetic north", next: "done" },
      { id: "other", type: "send_text", text: "Synthetic other", next: "done" },
      { id: "done", type: "end" },
    ] };
}

test("entry commands: explicit disabled roots preserve dormant components without admitting arbitrary orphans", () => {
  const definition = parseBotFlow(entryCommandFlow());
  assert.equal(definition.entryCommands?.length, 4);
  assert.equal(resolveBotEntryCommand(definition, undefined, { type: "text", text: "Special package" }), null);
  assert.throws(() => parseBotFlow({ ...definition, nodes: [...definition.nodes, { id: "orphan", type: "end" }] }), /unreachable/);
  assert.throws(() => parseBotFlow({ ...definition, entryCommands: definition.entryCommands?.map((row, i) => i ? row : { ...row, target: "missing" }) }), /target does not exist/);
  assert.deepEqual(botFlowEntryRoots({ ...definition, mainMenuNodeId: "menu" }), ["menu", "special", "offer", "north", "other"]);
  assert.deepEqual(botFlowEntryRoots({ ...definition, mainMenuNodeId: null }), ["menu", "special", "offer", "north", "other"]);
  assert.equal("entryCommands" in parseBotFlow(flow), false);
});

test("entry commands: exact normalized own text lookup consumes no menu selection or native payload", () => {
  const definition = parseBotFlow(entryCommandFlow(true));
  assert.deepEqual(resolveBotEntryCommand(definition, undefined, { type: "text", text: "  ＳＰＥＣＩＡＬ package  " }), { id: "special_entry", target: "special" });
  assert.deepEqual(resolveBotEntryCommand(definition, "menu", { type: "text", text: "منطقة شمالية" }), { id: "north_entry", target: "north" });
  assert.equal(resolveBotEntryCommand(definition, "menu", { type: "text", text: "prefix Special package" }), null);
  assert.equal(resolveBotEntryCommand(definition, "offer", { type: "text", text: "North area" }), null);
  assert.equal(resolveBotEntryCommand(definition, "offer", { type: "text", text: "١" }), null);
  assert.equal(resolveBotEntryCommand(definition, "offer", { type: "choice", choiceId: "North area" }), null);
  const entry = resolveBotEntryCommand(definition, undefined, { type: "text", text: "Local delivery" });
  assert.ok(entry);
  const advanced = advanceBotFlow(definition, entry.target, undefined, { "message.text": "Local delivery" });
  assert.equal(advanced.currentNodeId, "offer");
  assert.equal(advanced.state, "WAITING");
  assert.equal(advanced.effects[0].type, "send_choices");
});

test("entry commands: a genuinely new text entry skips only current-menu precedence", () => {
  const input = entryCommandFlow(true);
  input.nodes[0] = { id: "menu", type: "choice", prompt: "Choose", options: [{ id: "special", label: "Special package", next: "special" }] };
  const definition = parseBotFlow(input);
  assert.equal(resolveBotEntryCommand(definition, "menu", { type: "text", text: "Special package" }), null);
  assert.deepEqual(resolveBotEntryCommand(definition, undefined, { type: "text", text: "Special package" }), { id: "special_entry", target: "special" });
  assert.equal(resolveBotEntryCommand(definition, undefined, { type: "text", text: "1" }), null);
});

test("entry commands: numeric, reserved, duplicate and ambiguous aliases fail closed", () => {
  for (const alias of ["1", "١", "۱", "１２", "Main menu", "القائمة الرئيسية", "Resolve my ticket", "حل تذكرتي", "{{message.text}}", "hidden\u200bcommand"]) {
    const definition = entryCommandFlow(); definition.entryCommands[0].aliases = [alias];
    assert.throws(() => parseBotFlow(definition), /alias.*(reserved|invalid)/);
  }
  const duplicate = entryCommandFlow(); duplicate.entryCommands[1].aliases = ["ＳＰＥＣＩＡＬ package"];
  assert.throws(() => parseBotFlow(duplicate), /alias is duplicated/);
  const conflict = entryCommandFlow(); conflict.entryCommands[0].aliases = ["Continue"];
  assert.throws(() => parseBotFlow(conflict), /conflicts with a menu choice/);
  const duplicateId = entryCommandFlow(); duplicateId.entryCommands[1].id = duplicateId.entryCommands[0].id;
  assert.throws(() => parseBotFlow(duplicateId), /id is duplicated/);
});

test("entry commands: every declared root receives fresh variable provenance even while disabled", () => {
  const declaration = { id: "answer_entry", aliases: ["Stored answer"], target: "answer", enabled: false };
  assert.throws(() => validateBotFlowVariableProvenance(parseBotFlow({ ...flow, entryCommands: [declaration] }), new Map([["orders.lookup", ["action.status"]]])), /unavailable variable action.status/);
  validateBotFlowVariableProvenance(parseBotFlow(entryCommandFlow()), new Map());
});


test("fresh entry and welcome roots define neutral intrinsic fields for text and location inputs", () => {
  const input=entryCommandFlow(true);
  input.nodes[0]={id:"menu",type:"choice",prompt:"Text={{message.text}}; choice={{message.choice_label}}; location={{message.location.latitude}}/{{message.location.name}}",options:[{id:"go",label:"Agent {{message.choice_id}}",next:"special"}]};
  const parsed=parseBotFlow({...input,welcomeResendMinutes:60});
  for(const [variables,expected] of [
    [{"message.text":"Hello"},"Text=Hello; choice=; location=/"],
    [{"message.location.latitude":"24.7"},"Text=; choice=; location=24.7/"],
  ] as const){
    const advanced=advanceBotFlow(parsed,parsed.start,undefined,variables);
    assert.equal(advanced.effects[0].type,"send_choices");
    if(advanced.effects[0].type!=="send_choices")throw new Error("Expected welcome choices");
    assert.equal(advanced.effects[0].prompt,expected);
    assert.equal(advanced.effects[0].options[0].label,"Agent ");
    assert.equal(resolveBotEntryCommand(parsed,parsed.start,{type:"text",text:"Agent "},variables),null);
  }
  input.nodes[0].prompt="Status {{action.status}}";
  assert.throws(()=>validateBotFlowVariableProvenance(parseBotFlow(input),new Map()),/unavailable variable action.status/);
});
