import type { ResolvedSecret } from "./types.js";
import { isOwnedSecretReference, type SecretOwner } from "../../../packages/core/src/secret-reference.js";

const MAX_SECRET_BYTES=16_384;
const MAX_SECRET_FIELDS=16;
const SECRET_REFERENCE=/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u;
const SECRET_FIELDS=new Set(["apiKey","accessToken","refreshToken","token","hmacKey","value","routeToken","jwt_secret","instance_id"]);

export interface SecretResolver{resolve(reference:string,owner:SecretOwner):Promise<ResolvedSecret>}
export class SecretResolutionError extends Error{readonly retryable:boolean;constructor(message:string,retryable:boolean){super(message);this.name="SecretResolutionError";this.retryable=retryable}}
export function isBotActionSecretReference(tenantId:string,kind:string,reference:string|undefined,actionKey:string){
  return Boolean(reference&&actionKey&&isOwnedSecretReference(reference,{kind:"bot-action",tenantId,actionKey,actionKind:kind}));
}
export class SidecarSecretResolver implements SecretResolver{
  private readonly baseUrl:URL;private readonly bearerToken:string;private readonly trustedExactReferences:Set<string>;
  constructor(baseUrl:string,bearerToken:string,production=process.env.NODE_ENV==="production",trustedExactReferences:Iterable<string>=[]){
    this.baseUrl=sidecarUrl(baseUrl,production);this.bearerToken=bearerToken;this.trustedExactReferences=new Set(trustedExactReferences);
  }
  async resolve(reference:string,owner:SecretOwner){
    validateReference(reference);
    if(!isOwnedSecretReference(reference,owner))throw new SecretResolutionError("Secret reference is outside its owner namespace",false);
    if(owner.kind==="exact"&&!this.trustedExactReferences.has(owner.expectedReference))throw new SecretResolutionError("Secret reference is not in trusted worker configuration",false);
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5_000);
    try{
      const response=await fetch(new URL("/v1/resolve",this.baseUrl),{method:"POST",headers:{authorization:`Bearer ${this.bearerToken}`,"content-type":"application/json",accept:"application/json"},body:JSON.stringify({reference}),redirect:"error",signal:controller.signal});
      if(!response.ok)throw new SecretResolutionError(`Secret resolver returned ${response.status}`,retryableStatus(response.status));
      if((response.headers.get("content-type")??"").split(";",1)[0]!.trim().toLocaleLowerCase("en")!=="application/json")throw invalidSecret();
      const declared=response.headers.get("content-length");
      if(declared!==null&&(!Number.isSafeInteger(Number(declared))||Number(declared)<0||Number(declared)>MAX_SECRET_BYTES))throw invalidSecret();
      const bytes=await readBounded(response);
      let value:unknown;
      try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown}catch{throw invalidSecret()}
      return resolvedSecret(value,owner);
    }catch(error){if(error instanceof SecretResolutionError)throw error;throw new SecretResolutionError("Secret resolver timed out or the network was unavailable",true)}finally{clearTimeout(timeout)}
  }
}

function sidecarUrl(value:string,production:boolean){
  let url:URL;try{url=new URL(value)}catch{throw new Error("Secret sidecar URL is invalid")}
  if((url.protocol!=="http:"&&url.protocol!=="https:")||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("Secret sidecar URL is invalid");
  if(production&&url.protocol!=="https:")throw new Error("Secret sidecar must use HTTPS in production");
  return url;
}

function validateReference(reference:string){if(Buffer.byteLength(reference,"utf8")>512||!SECRET_REFERENCE.test(reference))throw new SecretResolutionError("Invalid secret reference",false)}
function retryableStatus(status:number){return status===408||status===425||status===429||status>=500}
function invalidSecret(){return new SecretResolutionError("Secret resolver returned an invalid value",false)}

function resolvedSecret(value:unknown,owner:SecretOwner):ResolvedSecret{
  if(!isPlainObject(value)||Object.keys(value).length>MAX_SECRET_FIELDS)throw invalidSecret();
  // Zammad provisioning shares this record; validate its purpose-specific field
  // but never return it to worker consumers.
  const provisioningField=owner.kind==="zammad"?(owner.purpose==="service"?"bootstrap_password":"key"):undefined;
  for(const [key,item] of Object.entries(value))if((!SECRET_FIELDS.has(key)&&key!==provisioningField&&!(owner.kind==="meta-connection"&&key==="registrationPin"))||typeof item!=="string"||!item||Buffer.byteLength(item,"utf8")>4_096||hasControl(item))throw invalidSecret();
  const result:ResolvedSecret={};
  for(const key of ["apiKey","accessToken","token","hmacKey","routeToken","value"] as const){const item=value[key];if(typeof item==="string")result[key]=item}
  if(owner.kind==="meta-connection"&&value.registrationPin!==undefined){if(typeof value.registrationPin!=="string"||!/^\d{6}$/u.test(value.registrationPin))throw invalidSecret();result.registrationPin=value.registrationPin}
  if(!Object.keys(result).length)throw invalidSecret();
  return result;
}

function isPlainObject(value:unknown):value is Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))return false;const prototype=Object.getPrototypeOf(value);return prototype===Object.prototype||prototype===null}
function hasControl(value:string){return Array.from(value).some(character=>{const code=character.codePointAt(0)??0;return code<32||code===127})}

async function readBounded(response:Response){
  if(!response.body)throw invalidSecret();
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const{done,value}=await reader.read();if(done)break;if(!value?.byteLength)continue;total+=value.byteLength;if(total>MAX_SECRET_BYTES){await reader.cancel().catch(()=>undefined);throw invalidSecret()}chunks.push(value)}}finally{reader.releaseLock()}
  if(!total)throw invalidSecret();
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return bytes;
}
