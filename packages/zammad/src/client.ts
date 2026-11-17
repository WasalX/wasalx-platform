export type ZammadAttachment={filename:string;data:string;"mime-type":string};
export type ZammadAttachmentContent={bytes:Uint8Array;mimeType:string};
export type ZammadArticlePreferences={wasalx_origin?:"provider"|"bot";wasalx_external_message_id?:string;wasalx_mutation_event_id?:string;wasalx_mutation_kind?:"EDITED"|"REVOKED";wasalx_mutation_target_message_id?:string;wasalx_bot_delivery_key?:string;wasalx_group_command_key?:string;wasalx_handoff_key?:string};
export type ZammadArticle={ticket_id:number;body:string;content_type:"text/html"|"text/plain";type:"note"|"wasalx group message";internal:boolean;sender:"Customer"|"Agent"|"System";origin_by_id?:number;subject?:string;attachments?:ZammadAttachment[];preferences?:ZammadArticlePreferences};
export type ZammadArticleSummary={id:number;preferences?:Record<string,unknown>};
export type ZammadTicket={id:number;number:string;state:string;group:string;title:string;group_id?:number;owner_id?:number;updated_at?:string;wasalx_correlation_key?:string};
export type ZammadUser={id:number;login:string;firstname:string;lastname:string;email?:string;mobile?:string|null;preferences?:Record<string,unknown>};
export type ZammadRoutingTargets={groups:Array<{id:string;active:boolean;serviceIdentityCanCreate:boolean}>;owners:Array<{id:string;active:boolean;groupIds:string[]}>};
export type ZammadTicketTitleInput=
  |{kind:"group";groupName?:string|null;ruleName?:string|null;reference?:string|null}
  |{kind:"direct";customerName?:string|null};
type Config={baseUrl:string;token:string;beforeRequest?:()=>Promise<void>};
export class ZammadError extends Error{constructor(message:string,public readonly retryable:boolean,public readonly status?:number){super(message);this.name="ZammadError"}}

const ZAMMAD_TITLE_MAX_CODE_POINTS=200;
const titleSegmenter=new Intl.Segmenter("und",{granularity:"grapheme"});

export function formatZammadTicketTitle(input:ZammadTicketTitleInput){
  return input.kind==="direct"
    ? fitZammadTitle([safeTitlePart(input.customerName,"WhatsApp participant"),"WhatsApp conversation"],[" — "])
    : fitZammadTitle([
      safeTitlePart(input.groupName,"WhatsApp group"),
      safeTitlePart(input.ruleName,"Reference"),
      safeTitlePart(input.reference,"Unknown reference"),
    ],[" — ",": "]);
}

export class ZammadClient{
  private readonly config:Config;
  constructor(config:Config){this.config=config}
  private async request<T>(path:string,init:RequestInit={}):Promise<T>{await this.config.beforeRequest?.();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15_000);try{const response=await fetch(new URL(path,this.config.baseUrl),{...init,headers:{authorization:`Token token=${this.config.token}`,"content-type":"application/json",...init.headers},redirect:"error",signal:controller.signal});if(!response.ok)throw new ZammadError(`Zammad request failed (${response.status})`,response.status===408||response.status===429||response.status>=500,response.status);return response.json() as Promise<T>}catch(error){if(error instanceof ZammadError)throw error;throw new ZammadError("Zammad request timed out or the network was unavailable",true)}finally{clearTimeout(timeout)}}
  async routingTargets():Promise<ZammadRoutingTargets>{
    const [currentUser,groups,users]=await Promise.all([this.request<Record<string,unknown>>("/api/v1/users/me"),this.pages("/api/v1/groups"),this.pages("/api/v1/users")]);
    const permissions=zammadGroupPermissions(currentUser.group_ids);const serviceId=zammadPositiveId(currentUser.id);
    const usableGroups=groups.flatMap(group=>{const id=zammadPositiveId(group.id);if(!id)return[];const allowed=permissions.get(id)??[];return[{id,active:group.active!==false,serviceIdentityCanCreate:allowed.includes("full")||allowed.includes("create")}]});
    const writableGroupIds=new Set(usableGroups.filter(group=>group.serviceIdentityCanCreate).map(group=>group.id));
    const owners=users.flatMap(user=>{const id=zammadPositiveId(user.id);const groupIds=[...zammadGroupPermissions(user.group_ids)].filter(([groupId,access])=>writableGroupIds.has(groupId)&&access.includes("full")).map(([groupId])=>groupId).sort((left,right)=>Number(left)-Number(right));return!id||id===serviceId||!groupIds.length?[]:[{id,active:user.active!==false,groupIds}]});
    return{groups:usableGroups,owners};
  }
  async ensureCustomer(input:{login:string;firstname:string;mobile?:string}):Promise<ZammadUser>{
    if(input.mobile!==undefined&&!/^\+[1-9][0-9]{5,14}$/u.test(input.mobile))throw new ZammadError("Invalid customer mobile",false);
    const existing=await this.findUserByLogin(input.login);
    if(existing)return this.ensureCustomerIdentity(existing,input);
    try{
      return await this.request<ZammadUser>("/api/v1/users",{method:"POST",body:JSON.stringify({login:input.login,firstname:input.firstname,preferences:{wasalx_identity:{login:input.login,lastAppliedName:input.firstname}},active:true,...(input.mobile?{mobile:input.mobile}:{})})});
    }catch(error){
      // Concurrent delivery workers can both miss the initial lookup. Zammad's
      // case-insensitive login uniqueness is the final fence; resolve the winner
      // after a duplicate-user response instead of creating a second identity.
      if(!(error instanceof ZammadError)||error.status!==422)throw error;
      const concurrent=await this.findUserByLogin(input.login);
      if(concurrent)return this.ensureCustomerIdentity(concurrent,input);
      const exact=(await this.pages("/api/v1/users")).find(user=>typeof user.login==="string"&&user.login.toLocaleLowerCase("en-US")===input.login.toLocaleLowerCase("en-US")&&Boolean(zammadPositiveId(user.id))&&(user.mobile===undefined||user.mobile===null||typeof user.mobile==="string"));
      if(exact)return this.ensureCustomerIdentity(exact as ZammadUser,input);
      throw error;
    }
  }
  createTicket(input:{title:string;group:string;customerId:number;body:string;reference:string;priority:string;ownerId?:number;articleSender?:"Customer"|"Agent";metadata:Record<string,string>;articlePreferences:ZammadArticlePreferences;attachments?:ZammadAttachment[]}):Promise<ZammadTicket>{const routing=/^[1-9]\d{0,9}$/u.test(input.group)?{group_id:Number(input.group)}:{group:input.group};const sender=input.articleSender??"Customer";return this.request("/api/v1/tickets",{method:"POST",body:JSON.stringify({title:input.title,...routing,customer_id:input.customerId,priority:input.priority,...(input.ownerId===undefined?{}:{owner_id:input.ownerId}),article:{subject:input.title,body:input.body,type:"wasalx group message",internal:false,sender,...(sender==="Customer"?{origin_by_id:input.customerId}:{}),preferences:input.articlePreferences,...(input.attachments?.length?{attachments:input.attachments}:{})},wasalx_reference:input.reference,...input.metadata})})}
  addArticle(ticketId:number,article:Omit<ZammadArticle,"ticket_id">){return this.request<ZammadArticleSummary>(`/api/v1/ticket_articles`,{method:"POST",body:JSON.stringify({...article,ticket_id:ticketId})})}
  async hasTicketArticlePreference(ticketId:number,key:string,value:string){
    return Boolean(await this.findTicketArticlePreference(ticketId,key,value));
  }
  async findTicketArticlePreference(ticketId:number,key:string,value:string){
    if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new ZammadError("Invalid Zammad ticket ID",false);
    if(!/^[a-z0-9_]{1,64}$/.test(key)||value.length<1||value.length>512)throw new ZammadError("Invalid Zammad article preference lookup",false);
    const result=await this.request<ZammadArticleSummary[]|{assets?:Record<string,ZammadArticleSummary>}>(`/api/v1/ticket_articles/by_ticket/${ticketId}`);
    const articles=Array.isArray(result)?result:Object.values(result.assets??{});
    return articles.find(article=>article.preferences?.[key]===value)??null;
  }

  readQuotedCommandContext(ticketId:number,memberEmail:string|null):Promise<{updatedAt:string;stateId:string;lastArticleId:string;nativeGroupId:string;connectionId:string;externalGroupId:string;activeAgent:boolean;deniedTranscript?:string}>{
    return this.request<Record<string,unknown>>('/api/v1/wasalx/tickets/'+ticketId+'/quoted-command-context',{method:'POST',body:JSON.stringify({member_email:memberEmail??''})}).then(row=>{
      for(const key of ['updated_at','state_id','last_article_id','native_group_id','connection_id','external_group_id'])if(typeof row[key]!=='string')throw new ZammadError('Native command context is invalid',false);
      if(typeof row.active_agent!=='boolean'||!Number.isFinite(Date.parse(String(row.updated_at))))throw new ZammadError('Native command context is invalid',false);
      return {updatedAt:String(row.updated_at),stateId:String(row.state_id),lastArticleId:String(row.last_article_id),nativeGroupId:String(row.native_group_id),connectionId:String(row.connection_id),externalGroupId:String(row.external_group_id),activeAgent:row.active_agent,...(row.denied_command_transcript==='v1'?{deniedTranscript:'v1'}:{})};
    });
  }
  closeQuotedCommand(ticketId:number,executionId:string){return this.request<{state:string;execution_id?:string;ticket_id?:string;request_sha256?:string;article_id?:string}>('/api/v1/wasalx/tickets/'+ticketId+'/quoted-commands/'+executionId,{method:'POST',body:'{}'});}
  readQuotedCommandReceipt(ticketId:number,executionId:string){return this.request<{state:string;execution_id?:string;ticket_id?:string;request_sha256?:string;article_id?:string}>('/api/v1/wasalx/tickets/'+ticketId+'/quoted-commands/'+executionId);}
  async readDirectCustomerCloseContext(ticketId:number):Promise<{updated_at:string;state_id:string;last_article_id:string;native_group_id:string;connection_id:string;external_chat_id:string;customer_id:string;closed:boolean}>{
    const row=await this.request<Record<string,unknown>>('/api/v1/wasalx/tickets/'+ticketId+'/customer-close-context',{method:'POST',body:'{}'});
    for(const key of ['updated_at','state_id','last_article_id','native_group_id','connection_id','external_chat_id','customer_id'])if(typeof row[key]!=='string')throw new ZammadError('Direct customer close context is invalid',false);
    if(!Number.isFinite(Date.parse(String(row.updated_at)))||!['state_id','native_group_id','customer_id'].every(key=>/^[1-9][0-9]{0,15}$/u.test(String(row[key]))))throw new ZammadError('Direct customer close context is invalid',false);
    if(typeof row.closed!=='boolean')throw new ZammadError('Direct customer close context is invalid',false);
    return row as {updated_at:string;state_id:string;last_article_id:string;native_group_id:string;connection_id:string;external_chat_id:string;customer_id:string;closed:boolean};
  }
  closeDirectCustomerTicket(ticketId:number,commandId:string){return this.request<unknown>('/api/v1/wasalx/tickets/'+ticketId+'/customer-closes/'+commandId,{method:'POST',body:'{}'});}
  readDirectCustomerCloseReceipt(ticketId:number,commandId:string){return this.request<unknown>('/api/v1/wasalx/tickets/'+ticketId+'/customer-closes/'+commandId);}
  updateTicket(ticketId:number,changes:Record<string,unknown>):Promise<ZammadTicket>{return this.request(`/api/v1/tickets/${ticketId}`,{method:"PUT",body:JSON.stringify(changes)})}
  async getTicket(ticketId:number):Promise<ZammadTicket>{
    if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new ZammadError("Invalid Zammad ticket ID",false);
    const ticket=await this.request<ZammadTicket>(`/api/v1/tickets/${ticketId}?expand=true`);
    if(!zammadRecord(ticket)||Number(zammadPositiveId(ticket.id))!==ticketId||typeof ticket.state!=="string"||!ticket.state.trim()||typeof ticket.title!=="string")throw new ZammadError("Zammad ticket response is invalid",false);
    return {...ticket,id:ticketId};
  }
  async findByCorrelationKey(correlationKey:string){
    const result=await this.request<ZammadTicket[]|{assets?:Record<string,ZammadTicket>}>(`/api/v1/tickets/search?query=${encodeURIComponent(`wasalx_correlation_key:${correlationKey}`)}&limit=2&expand=true`);
    const candidates=Array.isArray(result)?result:Object.values(result.assets??{});
    if(!candidates.length)return null;
    const exact=new Map<string,ZammadTicket>();
    for(const ticket of candidates){const id=zammadPositiveId(ticket.id);if(id&&ticket.wasalx_correlation_key===correlationKey)exact.set(id,ticket)}
    if(exact.size!==1)throw new ZammadError("Zammad ticket correlation is ambiguous",false);
    const [id,ticket]=exact.entries().next().value!;
    if(typeof ticket.state!=="string"||!ticket.state.trim())throw new ZammadError("Zammad ticket search result is invalid",false);
    return{...ticket,id:Number(id)};
  }
  private async findUserByLogin(login:string){
    const result=await this.request<ZammadUser[]|{assets?:Record<string,ZammadUser>}>(`/api/v1/users/search?query=${encodeURIComponent(`login:${login}`)}&limit=2`);
    const users=Array.isArray(result)?result:Object.values(result.assets??{});
    return users.find(user=>user.login.toLocaleLowerCase("en-US")===login.toLocaleLowerCase("en-US"))??null;
  }
  private async ensureCustomerIdentity(user:ZammadUser,input:{firstname:string;mobile?:string}):Promise<ZammadUser>{
    // Fresh native read narrows, but cannot eliminate, concurrent operator edits.
    const expectedId=user.id,expectedLogin=user.login;
    user=await this.request<ZammadUser>(`/api/v1/users/${user.id}`);
    if(user.id!==expectedId||user.login!==expectedLogin)throw new ZammadError("Customer identity readback mismatch",false);
    const changes:Record<string,unknown>={};
    if(input.mobile&&!user.mobile)changes.mobile=input.mobile;
    const clean=(value:string)=>value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/gu," ").trim();
    const existingName=clean(`${user.firstname??""} ${user.lastname??""}`);
    const incomingName=clean(input.firstname);
    const preferences=user.preferences&&typeof user.preferences==="object"&&!Array.isArray(user.preferences)?user.preferences:{};
    const raw=preferences.wasalx_identity;
    const receipt=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
    const owned=receipt?.login===user.login&&receipt?.lastAppliedName===existingName;
    const placeholder=!existingName||/^whatsapp participant$/iu.test(existingName)||existingName===user.mobile;
    const incomingHuman=Boolean(incomingName)&&!/^whatsapp participant$/iu.test(incomingName)&&!/^\+?[1-9][0-9]{5,19}(?:@(c\.us|s\.whatsapp\.net|lid))?$/iu.test(incomingName);
    if((owned||placeholder)&&incomingHuman&&incomingName!==existingName){
      changes.firstname=incomingName;changes.lastname="";
      changes.preferences={...preferences,wasalx_identity:{login:user.login,lastAppliedName:incomingName}};
    }
    if(Object.keys(changes).length)return this.request<ZammadUser>(`/api/v1/users/${user.id}`,{method:"PUT",body:JSON.stringify(changes)});
    return user;
  }
  async downloadAttachment(ticketId:number,articleId:number,attachmentId:number,maximumBytes:number):Promise<ZammadAttachmentContent>{
    for(const [label,value] of [["ticket",ticketId],["article",articleId],["attachment",attachmentId]] as const)if(!Number.isSafeInteger(value)||value<=0)throw new ZammadError(`Invalid Zammad ${label} ID`,false);
    return this.downloadBinary(`/api/v1/ticket_attachment/${ticketId}/${articleId}/${attachmentId}`,maximumBytes);
  }
  async downloadWorkspaceUpload(uploadId:string,storeId:number,maximumBytes:number):Promise<ZammadAttachmentContent>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(uploadId)||!Number.isSafeInteger(storeId)||storeId<=0)throw new ZammadError("Invalid group workspace upload",false);
    return this.downloadBinary(`/api/v1/wasalx/group_workspace/uploads/${uploadId}/${storeId}`,maximumBytes);
  }
  async deleteWorkspaceUpload(uploadId:string,storeId:number){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(uploadId)||!Number.isSafeInteger(storeId)||storeId<=0)throw new ZammadError("Invalid group workspace upload",false);
    await this.config.beforeRequest?.();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15_000);
    try{const response=await fetch(new URL(`/api/v1/wasalx/group_workspace/uploads/${uploadId}/${storeId}`,this.config.baseUrl),{method:"DELETE",headers:{authorization:`Token token=${this.config.token}`},redirect:"error",signal:controller.signal});if(!response.ok&&response.status!==404)throw new ZammadError("Zammad workspace upload cleanup failed",response.status===408||response.status===429||response.status>=500,response.status)}catch(error){if(error instanceof ZammadError)throw error;throw new ZammadError("Zammad workspace upload cleanup timed out or the network was unavailable",true)}finally{clearTimeout(timeout)}
  }
  private async downloadBinary(path:string,maximumBytes:number):Promise<ZammadAttachmentContent>{
    if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>100_000_000)throw new ZammadError("Invalid Zammad attachment size limit",false);
    await this.config.beforeRequest?.();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),30_000);
    try{const response=await fetch(new URL(path,this.config.baseUrl),{headers:{authorization:`Token token=${this.config.token}`,accept:"application/octet-stream"},redirect:"error",signal:controller.signal});if(!response.ok)throw new ZammadError("Zammad attachment download failed",response.status===408||response.status===429||response.status>=500,response.status);const lengthHeader=response.headers.get("content-length");if(lengthHeader){const declared=Number(lengthHeader);if(!Number.isSafeInteger(declared)||declared<1||declared>maximumBytes)throw new ZammadError("Zammad attachment size is outside the allowed range",false)}if(!response.body)throw new ZammadError("Zammad attachment response was empty",true);const bytes=await boundedAttachmentBody(response.body,maximumBytes);const mimeType=(response.headers.get("content-type")??"").split(";",1)[0]!.trim().toLowerCase();if(!mimeType||mimeType.length>127)throw new ZammadError("Zammad attachment content type is invalid",false);return{bytes,mimeType}}catch(error){if(error instanceof ZammadError)throw error;throw new ZammadError("Zammad attachment download timed out or the network was unavailable",true)}finally{clearTimeout(timeout)}
  }
  async health(){await this.request("/api/v1/online-notification-count");return{ok:true}}
  private async pages(path:string){const rows:Record<string,unknown>[]=[];for(let page=1;page<=5;page++){const value=await this.request<unknown>(`${path}?page=${page}&per_page=100`);if(!Array.isArray(value)||!value.every(zammadRecord))throw new ZammadError("Zammad routing catalog is invalid",false);rows.push(...value);if(value.length<100)return rows}throw new ZammadError("Zammad routing catalog exceeded the safe item limit",false)}
}

function zammadGroupPermissions(value:unknown){const result=new Map<string,string[]>();if(!zammadRecord(value))return result;for(const[idValue,permissionValue]of Object.entries(value)){const id=zammadPositiveId(idValue);if(id&&Array.isArray(permissionValue))result.set(id,permissionValue.filter((item):item is string=>typeof item==="string"))}return result}
function zammadPositiveId(value:unknown){const result=String(value??"");return/^[1-9]\d{0,9}$/u.test(result)?result:null}
function zammadRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)}

function safeTitlePart(value:string|null|undefined,fallback:string){
  const result=(value??"").normalize("NFC")
    .replace(/[\uD800-\uDFFF]/gu,"�")
    .replace(/\p{Cc}/gu," ")
    .replace(/\p{Cf}/gu,character=>character==="\u200c"||character==="\u200d"?character:" ")
    .replace(/\s+/gu," ").trim();
  return result||fallback;
}

function fitZammadTitle(parts:string[],separators:string[]){
  const values=[...parts];
  while(titleCodePoints(joinTitle(values,separators))>ZAMMAD_TITLE_MAX_CODE_POINTS){
    const lengths=values.map(titleCodePoints);
    const overflow=titleCodePoints(joinTitle(values,separators))-ZAMMAD_TITLE_MAX_CODE_POINTS;
    let index=lengths.slice(0,-1).reduce((longest,length,candidate)=>length>(lengths[longest]??0)?candidate:longest,0);
    if((lengths[index]??0)<=12)index=values.length-1;
    values[index]=clipTitlePart(values[index]??"",Math.max(index===values.length-1?1:12,(lengths[index]??0)-overflow));
  }
  return joinTitle(values,separators);
}

function joinTitle(parts:string[],separators:string[]){return parts.map((part,index)=>`${index?separators[index-1]??" ":""}${part}`).join("")}
function titleCodePoints(value:string){return [...value].length}
function clipTitlePart(value:string,maximum:number){
  if(titleCodePoints(value)<=maximum)return value;
  if(maximum<=1)return "…";
  const segments:string[]=[];let used=0;
  for(const {segment} of titleSegmenter.segment(value)){
    const length=titleCodePoints(segment);
    if(used+length>maximum-1)break;
    segments.push(segment);used+=length;
  }
  return `${segments.join("")}…`;
}

async function boundedAttachmentBody(stream:ReadableStream<Uint8Array>,maximum:number){const reader=stream.getReader();const chunks:Uint8Array[]=[];let total=0;try{while(true){const{value,done}=await reader.read();if(done)break;if(!value?.length)continue;total+=value.length;if(total>maximum){await reader.cancel();throw new ZammadError("Zammad attachment size is outside the allowed range",false)}chunks.push(value)}}finally{reader.releaseLock()}if(total===0)throw new ZammadError("Zammad attachment response was empty",true);const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}return result}
