export type ClientRoutingSource = {
  id: string;
  name: string;
  kind: "MANUAL" | "NOTION" | "ZOHO" | "HTTP_JSON";
  syncMode: "MANUAL" | "WEBHOOK" | "SCHEDULED" | "HYBRID";
  secretReference?: string;
  endpointUrl?: string;
  scheduleMinutes?: number;
  fieldMapping: Record<string, string>;
};

export type ClientRouteMatcher = {
  kind: "WHATSAPP_GROUP" | "CLIENT_IDENTIFIER" | "EMAIL" | "DOMAIN";
  value: string;
  sourceId: string;
  namespace?: string;
  connectionId?: string;
};

export type ClientRoute = {
  id: string;
  name: string;
  routeSourceId: string;
  zammadGroupId: string;
  ownerId?: string;
  escalationGroupId?: string;
  escalationOwnerId?: string;
  matchers: ClientRouteMatcher[];
};

export type ClientRoutingDefinition = {
  schemaVersion: 1;
  name: string;
  /** Native entry queues eligible for client routing. Absence is disabled. */
  supportGroupIds?: string[];
  fallback: { zammadGroupId: string; ownerId?: string };
  sources: ClientRoutingSource[];
  clients: ClientRoute[];
};

export type ClientRoutingInput = {
  connectionId?: string;
  whatsappGroupId?: string;
  identifier?: string;
  identifierNamespace?: string;
  email?: string;
  entryGroupId?: string;
};

/** Preserve explicit active scope; only an unambiguous first setup gets a default. */
export function routingStarterSupportGroupIds(
  activeDefinition: Pick<ClientRoutingDefinition,"supportGroupIds"> | undefined,
  eligibleSupportQueueIds: readonly string[],
): string[] {
  if (activeDefinition) return [...(activeDefinition.supportGroupIds ?? [])];
  const eligible = [...new Set(eligibleSupportQueueIds)];
  return eligible.length === 1 ? eligible : [];
}

export type ClientRoutingResult = {
  status: "MATCHED" | "FALLBACK" | "CONFLICT";
  client: ClientRoute | null;
  matchedBy: ClientRouteMatcher["kind"] | "FALLBACK";
  competingClientIds: string[];
};

export type ClientRoutingSourceSync = {
  mode: "FULL" | "DELTA";
  complete: boolean;
  expectedRevision: number;
  rows: Record<string, unknown>[];
};

export type ClientRoutingSourceSnapshot = {
  sourceId: string;
  revision: number;
  rows: Record<string, unknown>[];
};

export type ClientRoutingTargetCatalog = {
  groups: Array<{id:string;active:boolean;serviceIdentityCanCreate:boolean}>;
  owners: Array<{id:string;active:boolean;groupIds:string[]}>;
};

const ID=/^[a-z][a-z0-9_.-]{0,127}$/u;
const SECRET=/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseClientRouting(value:unknown):ClientRoutingDefinition{
  const input=record(value,"Client routing");
  if(input.schemaVersion!==1)throw new Error("Client routing schemaVersion must be 1");
  const name=text(input.name,"Client routing name",160);
  let supportGroupIds:string[]|undefined;
  if(input.supportGroupIds!==undefined){
    if(!Array.isArray(input.supportGroupIds)||input.supportGroupIds.length>100||input.supportGroupIds.some(id=>typeof id!=="string"||! /^[1-9][0-9]{0,15}$/u.test(id)))throw new Error("Support entry groups are invalid");
    supportGroupIds=[...new Set(input.supportGroupIds as string[])];
    if(supportGroupIds.length!==input.supportGroupIds.length)throw new Error("Support entry groups contain duplicates");
  }
  const fallbackInput=record(input.fallback,"Client routing fallback");
  const fallback={zammadGroupId:text(fallbackInput.zammadGroupId,"Fallback Zammad group",80),...(optionalText(fallbackInput.ownerId,"Fallback owner",80)?{ownerId:optionalText(fallbackInput.ownerId,"Fallback owner",80)}:{})};
  if(!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>25)throw new Error("Client routing must contain between 1 and 25 sources");
  if(!Array.isArray(input.clients)||input.clients.length>10_000)throw new Error("Client routing contains too many clients");
  const sources=input.sources.map(parseSource);const sourceIds=uniqueIds(sources,"source");
  const manualSourceIds=new Set(sources.filter(source=>source.kind==="MANUAL").map(source=>source.id));
  const clients=input.clients.map((client,index)=>parseClient(client,sourceIds,manualSourceIds,`Client route ${index+1}`));uniqueIds(clients,"client");
  const ownership=new Map<string,string>();
  for(const client of clients)for(const matcher of client.matchers){
    if(!sourceIds.has(matcher.sourceId))throw new Error(`Routing matcher source ${matcher.sourceId} does not exist`);
    const key=matcherKey(matcher);const existing=ownership.get(key);
    if(existing&&existing!==client.id)throw new Error(`Routing matcher ${matcher.kind} ${matcher.value} belongs to more than one client`);
    ownership.set(key,client.id);
  }
  return{schemaVersion:1,name,...(supportGroupIds===undefined?{}:{supportGroupIds}),fallback,sources,clients};
}

export function clientRoutingApplies(definition:ClientRoutingDefinition,entryGroupId:string|undefined){
  return typeof entryGroupId==="string"&&definition.supportGroupIds?.includes(entryGroupId)===true;
}

export function resolveClientRoute(definition:ClientRoutingDefinition,input:ClientRoutingInput):ClientRoutingResult{
  const routing=parseClientRouting(definition);const candidates:Array<{client:ClientRoute;matcher:ClientRouteMatcher;rank:number}>=[];
  for(const client of routing.clients)for(const matcher of client.matchers){const rank=matchRank(matcher,input);if(rank)candidates.push({client,matcher,rank})}
  if(!candidates.length)return{status:"FALLBACK",client:null,matchedBy:"FALLBACK",competingClientIds:[]};
  const rank=Math.max(...candidates.map(candidate=>candidate.rank));const strongest=candidates.filter(candidate=>candidate.rank===rank);
  const clientIds=[...new Set(strongest.map(candidate=>candidate.client.id))];
  if(clientIds.length>1)return{status:"CONFLICT",client:null,matchedBy:strongest[0]!.matcher.kind,competingClientIds:clientIds.sort()};
  return{status:"MATCHED",client:strongest[0]!.client,matchedBy:strongest[0]!.matcher.kind,competingClientIds:[]};
}

export function normalizeRoutingEmail(value:string){return normalizeEmail(value)}

export function hasCredentialQueryParameter(url:URL){
  return [...url.searchParams.keys()].some(key=>{
    const normalized=key.normalize("NFKC").toLocaleLowerCase("en").replaceAll(/[^a-z0-9]/gu,"");
    return["token","secret","password","passwd","credential","authorization","apikey","accesskey","privatekey","clientsecret","signature","accessid"].some(value=>normalized.includes(value))||["auth","pwd","sig","key"].includes(normalized);
  });
}

export function materializeClientRoutingSourceSnapshot(source:ClientRoutingSource,previous:ClientRoutingSourceSnapshot,value:unknown):ClientRoutingSourceSnapshot{
  if(previous.sourceId!==source.id)throw new Error("Routing source snapshot does not match the connector");
  const input=record(value,"Routing source sync");
  if(input.mode!=="FULL"&&input.mode!=="DELTA")throw new Error("Routing source sync mode is invalid");
  if(input.complete!==(input.mode==="FULL"))throw new Error("Only a complete full pull may replace a source snapshot");
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==previous.revision)throw new Error("Routing source snapshot changed; refresh before syncing");
  if(!Array.isArray(input.rows)||input.rows.length>10_000)throw new Error("Routing source sync rows are invalid");
  const incoming=canonicalRows(normalizeSourceRows(source,input.rows));const current=groupSourceRows(canonicalRows(normalizeSourceRows({...source,fieldMapping:{}},previous.rows)));
  const next=input.mode==="FULL"?new Map<string,Record<string,unknown>[]>():current;
  for(const [clientId,rows] of groupSourceRows(incoming)){
    if(rows[0]?.deleted===true)next.delete(clientId);else next.set(clientId,rows);
  }
  return{sourceId:source.id,revision:previous.revision+1,rows:canonicalRows([...next.values()].flat())};
}

export function deriveClientRoutingFromSourceSnapshots(definition:ClientRoutingDefinition,snapshots:ClientRoutingSourceSnapshot[]):ClientRoutingDefinition{
  const routing=parseClientRouting(definition);const sourceById=new Map(routing.sources.map(source=>[source.id,source]));
  const external=routing.sources.filter(source=>source.kind!=="MANUAL");const snapshotById=new Map<string,ClientRoutingSourceSnapshot>();
  for(const snapshot of snapshots){
    if(snapshotById.has(snapshot.sourceId))throw new Error(`Routing source snapshot ${snapshot.sourceId} is duplicated`);
    const source=sourceById.get(snapshot.sourceId);if(!source||source.kind==="MANUAL")throw new Error(`Routing source snapshot ${snapshot.sourceId} is invalid`);
    snapshotById.set(snapshot.sourceId,{...snapshot,rows:canonicalRows(normalizeSourceRows({...source,fieldMapping:{}},snapshot.rows))});
  }
  for(const source of external)if(!snapshotById.has(source.id))throw new Error(`Routing source snapshot ${source.id} is missing`);
  const manualSourceIds=new Set(routing.sources.filter(source=>source.kind==="MANUAL").map(source=>source.id));
  const clients=new Map<string,ClientRoute>();const sourceClients=new Map(external.map(source=>[source.id,new Set<string>()]));
  for(const configured of routing.clients){
    const matchers=configured.matchers.filter(matcher=>manualSourceIds.has(matcher.sourceId));
    clients.set(configured.id,{...configured,matchers});
  }
  for(const source of external){
    const rows=snapshotById.get(source.id)!.rows;
    for(const [clientId,clientRows] of groupSourceRows(rows)){
      if(clientRows.some(row=>row.deleted===true))throw new Error(`${clientId} materialized snapshot contains a tombstone`);
      const route=routeFromSourceRows(clientId,clientRows);const matchers=clientRows.map((row,index)=>parseMatcher({kind:row.matcher_kind,value:row.matcher_value,sourceId:source.id,namespace:row.matcher_namespace,connectionId:row.connection_id},`${clientId} ${source.id} matcher ${index+1}`));
      sourceClients.get(source.id)!.add(clientId);
      const existing=clients.get(clientId);
      if(!existing)clients.set(clientId,{id:clientId,routeSourceId:source.id,...route,matchers});
      else{
        const routeSource=sourceById.get(existing.routeSourceId)!;
        if(existing.routeSourceId===source.id)Object.assign(existing,route);
        else if(routeSource.kind!=="MANUAL"&&routeSignature(existing)!==routeSignature(route))throw new Error(`${clientId} route fields conflict across external sources`);
        existing.matchers.push(...matchers);
      }
    }
  }
  for(const [clientId,client] of clients){
    if(!client.matchers.length){clients.delete(clientId);continue}
    const routeSource=sourceById.get(client.routeSourceId)!;
    if(routeSource.kind!=="MANUAL"&&!sourceClients.get(routeSource.id)?.has(clientId))throw new Error(`${clientId} route source ${routeSource.id} no longer supplies the client`);
  }
  return parseClientRouting({...routing,clients:[...clients.values()].sort((left,right)=>left.id.localeCompare(right.id,"und")).map(client=>({...client,matchers:client.matchers.sort((left,right)=>matcherKey(left).localeCompare(matcherKey(right),"und"))}))});
}

export function clientRoutingTargetBlockers(definition:ClientRoutingDefinition,catalog:ClientRoutingTargetCatalog){
  const routing=parseClientRouting(definition);const blockers:string[]=[];
  const verify=(label:string,groupId:string,ownerId?:string)=>{
    const group=catalog.groups.find(item=>item.id===groupId);
    if(!group)blockers.push(`${label}: Zammad group ${groupId} does not exist`);
    else if(!group.active||!group.serviceIdentityCanCreate)blockers.push(`${label}: Zammad group ${groupId} is not available to WasalX`);
    if(ownerId){const owner=catalog.owners.find(item=>item.id===ownerId);if(!owner||!owner.active||!owner.groupIds.includes(groupId))blockers.push(`${label}: Zammad owner ${ownerId} is not active in group ${groupId}`)}
  };
  if(!routing.supportGroupIds?.length)blockers.push("Choose the support entry queues before activating client routing");
  for(const id of routing.supportGroupIds??[])verify("Support entry",id);
  verify("Fallback",routing.fallback.zammadGroupId,routing.fallback.ownerId);
  for(const client of routing.clients){verify(client.name,client.zammadGroupId,client.ownerId);if(client.escalationGroupId)verify(`${client.name} escalation`,client.escalationGroupId,client.escalationOwnerId)}
  return blockers.slice(0,50);
}

function normalizeSourceRows(source:ClientRoutingSource,values:unknown[]){
  return values.map((value,index)=>{
    const row=record(value,`${source.id} source row ${index+1}`);const clientId=identifier(sourceField(source,row,"client_id"),`${source.id} source row ${index+1} client`);
    const deleted=sourceField(source,row,"deleted");
    if(deleted!==undefined&&deleted!==true&&deleted!==false)throw new Error(`${clientId} deleted flag is invalid`);
    if(deleted===true){
      for(const field of ["client_name","zammad_group_id","owner_id","escalation_group_id","escalation_owner_id","matcher_kind","matcher_value","matcher_namespace","connection_id"])if(sourceField(source,row,field)!==undefined)throw new Error(`${clientId} tombstone cannot include route or matcher fields`);
      return{client_id:clientId,deleted:true};
    }
    const route=routeFromSourceRows(clientId,[{
      client_name:sourceField(source,row,"client_name"),zammad_group_id:sourceField(source,row,"zammad_group_id"),owner_id:sourceField(source,row,"owner_id"),
      escalation_group_id:sourceField(source,row,"escalation_group_id"),escalation_owner_id:sourceField(source,row,"escalation_owner_id"),
    }]);
    const matcher=parseMatcher({kind:sourceField(source,row,"matcher_kind"),value:sourceField(source,row,"matcher_value"),sourceId:source.id,namespace:sourceField(source,row,"matcher_namespace"),connectionId:sourceField(source,row,"connection_id")},`${clientId} source matcher ${index+1}`);
    return{client_id:clientId,client_name:route.name,zammad_group_id:route.zammadGroupId,...(route.ownerId?{owner_id:route.ownerId}:{}),...(route.escalationGroupId?{escalation_group_id:route.escalationGroupId}:{}),...(route.escalationOwnerId?{escalation_owner_id:route.escalationOwnerId}:{}),matcher_kind:matcher.kind,matcher_value:matcher.value,...(matcher.namespace?{matcher_namespace:matcher.namespace}:{}),...(matcher.connectionId?{connection_id:matcher.connectionId}:{})};
  });
}

function groupSourceRows(rows:Record<string,unknown>[]){
  const groups=new Map<string,Record<string,unknown>[]>();
  for(const row of rows){const clientId=String(row.client_id);groups.set(clientId,[...(groups.get(clientId)??[]),row])}
  return groups;
}

function canonicalRows(rows:Record<string,unknown>[]){
  return rows.sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right),"und"));
}

function routeFromSourceRows(clientId:string,rows:Record<string,unknown>[]){
  const routes=rows.map(row=>({name:text(row.client_name,`${clientId} name`,160),zammadGroupId:text(row.zammad_group_id,`${clientId} Zammad group`,80),...(optionalText(row.owner_id,`${clientId} owner`,80)?{ownerId:optionalText(row.owner_id,`${clientId} owner`,80)}:{}),...(optionalText(row.escalation_group_id,`${clientId} escalation group`,80)?{escalationGroupId:optionalText(row.escalation_group_id,`${clientId} escalation group`,80)}:{}),...(optionalText(row.escalation_owner_id,`${clientId} escalation owner`,80)?{escalationOwnerId:optionalText(row.escalation_owner_id,`${clientId} escalation owner`,80)}:{})}));
  if(routes.some(route=>routeSignature(route)!==routeSignature(routes[0]!)))throw new Error(`${clientId} source rows disagree on route fields`);
  return routes[0]!;
}

function routeSignature(route:Pick<ClientRoute,"name"|"zammadGroupId"|"ownerId"|"escalationGroupId"|"escalationOwnerId">){return JSON.stringify([route.name,route.zammadGroupId,route.ownerId??null,route.escalationGroupId??null,route.escalationOwnerId??null])}

function parseSource(value:unknown):ClientRoutingSource{
  const input=record(value,"Routing source");const id=identifier(input.id,"Routing source id");const name=text(input.name,"Routing source name",160);
  if(!["MANUAL","NOTION","ZOHO","HTTP_JSON"].includes(String(input.kind)))throw new Error(`${id} source kind is invalid`);
  if(!["MANUAL","WEBHOOK","SCHEDULED","HYBRID"].includes(String(input.syncMode)))throw new Error(`${id} sync mode is invalid`);
  const kind=input.kind as ClientRoutingSource["kind"];const syncMode=input.syncMode as ClientRoutingSource["syncMode"];
  if(kind==="MANUAL"&&syncMode!=="MANUAL")throw new Error(`${id} manual source must use manual sync`);
  if(kind!=="MANUAL"&&syncMode==="MANUAL")throw new Error(`${id} external source must enable webhook or scheduled sync`);
  const secretReference=optionalText(input.secretReference,`${id} secret reference`,512);
  if(kind!=="MANUAL"&&(!secretReference||!SECRET.test(secretReference)))throw new Error(`${id} secret reference is invalid`);
  const endpointUrl=optionalHttps(input.endpointUrl,`${id} endpoint URL`);
  if(kind!=="MANUAL"&&!endpointUrl)throw new Error(`${id} HTTPS endpoint is required`);
  if(kind==="NOTION"&&endpointUrl&&!isNotionSourceUrl(endpointUrl))throw new Error(`${id} must use the official Notion data source query endpoint`);
  if(kind==="ZOHO"&&endpointUrl&&!isZohoSourceUrl(endpointUrl))throw new Error(`${id} must use an official Zoho CRM v8 records endpoint`);
  const scheduleMinutes=input.scheduleMinutes===undefined?undefined:integer(input.scheduleMinutes,`${id} schedule`,5,10_080);
  if((syncMode==="SCHEDULED"||syncMode==="HYBRID")&&!scheduleMinutes)throw new Error(`${id} schedule is required`);
  const fieldMapping=stringMap(input.fieldMapping,`${id} field mapping`,25,160);
  return{id,name,kind,syncMode,fieldMapping,...(secretReference?{secretReference}:{}),...(endpointUrl?{endpointUrl}:{}),...(scheduleMinutes?{scheduleMinutes}:{})};
}

function sourceField(source:ClientRoutingSource,row:Record<string,unknown>,field:string){return row[source.fieldMapping[field]??field]}

function parseClient(value:unknown,sourceIds:Set<string>,manualSourceIds:Set<string>,label:string):ClientRoute{
  const input=record(value,label);const id=identifier(input.id,"Client id");
  if(!Array.isArray(input.matchers)||input.matchers.length<1||input.matchers.length>200)throw new Error(`${id} must contain between 1 and 200 matchers`);
  const matchers=input.matchers.map((matcher,index)=>parseMatcher(matcher,`${id} matcher ${index+1}`));
  const matchedSources=[...new Set(matchers.map(matcher=>matcher.sourceId))];
  const inferred=matchedSources.length===1?matchedSources[0]:matchedSources.filter(source=>manualSourceIds.has(source)).length===1?matchedSources.find(source=>manualSourceIds.has(source)):undefined;
  const routeSourceId=input.routeSourceId===undefined?inferred:identifier(input.routeSourceId,`${id} route source`);
  if(!routeSourceId||!sourceIds.has(routeSourceId))throw new Error(`${id} route source is invalid or ambiguous`);
  return{id,name:text(input.name,`${id} name`,160),routeSourceId,zammadGroupId:text(input.zammadGroupId,`${id} Zammad group`,80),
    ...(optionalText(input.ownerId,`${id} owner`,80)?{ownerId:optionalText(input.ownerId,`${id} owner`,80)}:{}),
    ...(optionalText(input.escalationGroupId,`${id} escalation group`,80)?{escalationGroupId:optionalText(input.escalationGroupId,`${id} escalation group`,80)}:{}),
    ...(optionalText(input.escalationOwnerId,`${id} escalation owner`,80)?{escalationOwnerId:optionalText(input.escalationOwnerId,`${id} escalation owner`,80)}:{}),
    matchers};
}

function parseMatcher(value:unknown,label:string):ClientRouteMatcher{
  const input=record(value,label);if(!["WHATSAPP_GROUP","CLIENT_IDENTIFIER","EMAIL","DOMAIN"].includes(String(input.kind)))throw new Error(`${label} kind is invalid`);
  const kind=input.kind as ClientRouteMatcher["kind"];let matcherValue=text(input.value,`${label} value`,512);const sourceId=identifier(input.sourceId,`${label} source`);
  const namespace=optionalText(input.namespace,`${label} namespace`,80);const connectionId=optionalText(input.connectionId,`${label} connection`,36);
  if(kind==="EMAIL")matcherValue=normalizeEmail(matcherValue);
  if(kind==="DOMAIN")matcherValue=normalizeDomain(matcherValue);
  if(kind==="CLIENT_IDENTIFIER"&&!namespace)throw new Error(`${label} namespace is required`);
  if(kind==="WHATSAPP_GROUP"&&(!connectionId||!UUID.test(connectionId)))throw new Error(`${label} connection is invalid`);
  return{kind,value:matcherValue,sourceId,...(namespace?{namespace:namespace.toLocaleLowerCase("und")}:{ }),...(connectionId?{connectionId:connectionId.toLowerCase()}:{})};
}

function matchRank(matcher:ClientRouteMatcher,input:ClientRoutingInput){
  if(matcher.kind==="WHATSAPP_GROUP"&&matcher.connectionId===input.connectionId?.toLowerCase()&&matcher.value===input.whatsappGroupId)return 400;
  if(matcher.kind==="CLIENT_IDENTIFIER"&&matcher.namespace===input.identifierNamespace?.trim().toLocaleLowerCase("und")&&matcher.value===input.identifier?.trim())return 300;
  if(matcher.kind==="EMAIL"&&input.email&&matcher.value===normalizeEmail(input.email))return 200;
  if(matcher.kind==="DOMAIN"&&input.email&&matcher.value===normalizeDomain(input.email.split("@").at(-1)??""))return 100;
  return 0;
}

function matcherKey(matcher:ClientRouteMatcher){return[matcher.kind,matcher.connectionId??"",matcher.namespace??"",matcher.value].join("\u001f")}
function normalizeEmail(value:string){
  const normalized=value.trim().toLocaleLowerCase("und");
  if(normalized.length>254)return invalidEmail();
  const separator=normalized.lastIndexOf("@");
  if(separator<1||separator!==normalized.indexOf("@"))return invalidEmail();
  const local=normalized.slice(0,separator);const domain=normalized.slice(separator+1);
  if(local.length>64||local.startsWith(".")||local.endsWith(".")||local.includes("..")
    ||!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(local))return invalidEmail();
  return`${local}@${normalizeDomain(domain)}`;
}
function normalizeDomain(value:string){
  const candidate=value.trim().toLocaleLowerCase("und");
  if(!candidate||candidate.startsWith(".")||candidate.includes("..")||/[\s/@:[\]]/u.test(candidate))return invalidDomain();
  const withoutRoot=candidate.endsWith(".")?candidate.slice(0,-1):candidate;
  if(!withoutRoot||withoutRoot.length>253||/^\d+(?:\.\d+){3}$/u.test(withoutRoot))return invalidDomain();
  let hostname:string;
  try{hostname=new URL(`https://${withoutRoot}`).hostname.toLocaleLowerCase("und")}catch{return invalidDomain()}
  if(!hostname||hostname.length>253||/^\d+(?:\.\d+){3}$/u.test(hostname))return invalidDomain();
  const labels=hostname.split(".");
  if(labels.length<2||!/[a-z]/u.test(labels.at(-1)??"")
    ||labels.some(label=>!label||label.length>63||label.startsWith("-")||label.endsWith("-")||!/^[a-z0-9-]+$/u.test(label)))return invalidDomain();
  return hostname;
}
function invalidEmail():never{throw new Error("Routing email is invalid")}
function invalidDomain():never{throw new Error("Routing domain is invalid")}
function uniqueIds<T extends{id:string}>(items:T[],label:string){const ids=new Set<string>();for(const item of items){if(ids.has(item.id))throw new Error(`Routing ${label} ${item.id} is duplicated`);ids.add(item.id)}return ids}
function record(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`${label} must be an object`);return value as Record<string,unknown>}
function text(value:unknown,label:string,maximum:number){if(typeof value!=="string"||value!==value.trim()||!value||[...value].length>maximum||[...value].some(character=>{const code=character.codePointAt(0)!;return code===127||(code<32&&code!==9&&code!==10&&code!==13)}))throw new Error(`${label} is invalid`);return value}
function optionalText(value:unknown,label:string,maximum:number){return value===undefined||value===null||value===""?undefined:text(value,label,maximum)}
function identifier(value:unknown,label:string){const result=text(value,label,128);if(!ID.test(result))throw new Error(`${label} is invalid`);return result}
function integer(value:unknown,label:string,minimum:number,maximum:number){if(!Number.isInteger(value)||(value as number)<minimum||(value as number)>maximum)throw new Error(`${label} is invalid`);return value as number}
function optionalHttps(value:unknown,label:string){if(value===undefined||value===null||value==="")return undefined;const parsed=new URL(text(value,label,2_048));if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.hash||hasCredentialQueryParameter(parsed))throw new Error(`${label} must be an HTTPS URL without credentials, credential query parameters, or fragments`);return parsed.toString()}
function isNotionSourceUrl(value:string){const url=new URL(value);return url.origin==="https://api.notion.com"&&/^\/v1\/data_sources\/(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/query$/iu.test(url.pathname)&&!url.search}
function isZohoSourceUrl(value:string){const url=new URL(value);return /^(?:www|sandbox|developer)\.zohoapis\.(?:com|eu|in|com\.au|com\.cn|jp|sa|ca)$/u.test(url.hostname)&&/^\/crm\/v8\/[A-Za-z][A-Za-z0-9_]*$/u.test(url.pathname)}
function stringMap(value:unknown,label:string,maximumEntries:number,maximumValue:number){const input=record(value,label);if(Object.keys(input).length>maximumEntries)throw new Error(`${label} has too many fields`);return Object.fromEntries(Object.entries(input).map(([key,item])=>[identifier(key,`${label} key`),text(item,`${label} value`,maximumValue)]))}
