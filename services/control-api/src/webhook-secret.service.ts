import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { isOwnedSecretReference, type SecretOwner } from "@wasalx/core/secret-reference";

const MAX_SECRET_BYTES=16_384;
const MAX_SECRET_FIELDS=16;
const SECRET_REFERENCE=/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u;
const SECRET_FIELDS=new Set(["apiKey","accessToken","refreshToken","token","hmacKey","value","routeToken","jwt_secret","instance_id"]);

@Injectable()
export class WebhookSecretService implements OnModuleDestroy{
  private readonly baseUrl:URL;private readonly bearerToken:string;private readonly controller=new AbortController();
  constructor(){this.baseUrl=sidecarUrl(required("SECRET_SIDECAR_URL"));this.bearerToken=required("SECRET_SIDECAR_TOKEN")}
  async resolveHmac(reference:string,owner:SecretOwner){const value=await this.resolve(reference,owner);const secret=typeof value.hmacKey==="string"?value.hmacKey:typeof value.value==="string"?value.value:"";if(Buffer.byteLength(secret,"utf8")<16)throw invalidSecret();return secret}
  async resolveRoutingCredential(reference:string,owner:SecretOwner){const value=await this.resolve(reference,owner);if(typeof value.hmacKey!=="string"||Buffer.byteLength(value.hmacKey,"utf8")<16)throw invalidSecret();return{hmacKey:value.hmacKey,...(typeof value.accessToken==="string"?{accessToken:value.accessToken}:{}),...(typeof value.refreshToken==="string"?{refreshToken:value.refreshToken}:{})}}
  private async resolve(reference:string,owner:SecretOwner){
    validateReference(reference);if(!isOwnedSecretReference(reference,owner))throw invalidSecret();let response:Response;
    try{response=await fetch(new URL("/v1/resolve",this.baseUrl),{method:"POST",headers:{authorization:`Bearer ${this.bearerToken}`,"content-type":"application/json",accept:"application/json"},body:JSON.stringify({reference}),redirect:"error",signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(5_000)])})}
    catch{throw unavailableSecret()}
    if(!response.ok)throw new WebhookSecretResolutionError("Webhook HMAC secret could not be resolved",retryableStatus(response.status));
    if((response.headers.get("content-type")??"").split(";",1)[0]!.trim().toLocaleLowerCase("en")!=="application/json")throw invalidSecret();
    const declared=response.headers.get("content-length");
    if(declared!==null&&(!Number.isSafeInteger(Number(declared))||Number(declared)<0||Number(declared)>MAX_SECRET_BYTES))throw invalidSecret();
    let bytes:Uint8Array;try{bytes=await readBounded(response)}catch(error){if(error instanceof WebhookSecretResolutionError)throw error;throw unavailableSecret()}let value:unknown;
    try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown}catch{throw invalidSecret()}
    if(!isPlainObject(value)||Object.keys(value).length>MAX_SECRET_FIELDS)throw invalidSecret();
    for(const [key,item] of Object.entries(value))if(!SECRET_FIELDS.has(key)||typeof item!=="string"||!item||Buffer.byteLength(item,"utf8")>4_096||hasControl(item))throw invalidSecret();
    if(typeof value.hmacKey==="string"&&typeof value.value==="string")throw invalidSecret();
    return value;
  }
  async routingRouteToken(reference:string,tenantId:string,sourceId:string){return createHmac("sha256",await this.resolveHmac(reference,{kind:"routing",tenantId})).update(`wasalx:routing-webhook:v1:${tenantId}:${sourceId}`).digest("base64url")}
  onModuleDestroy(){this.controller.abort()}
}

export class WebhookSecretResolutionError extends Error{constructor(message:string,readonly retryable:boolean){super(message);this.name="WebhookSecretResolutionError"}}

function sidecarUrl(value:string){
  let url:URL;try{url=new URL(value)}catch{throw new Error("Secret sidecar URL is invalid")}
  if((url.protocol!=="http:"&&url.protocol!=="https:")||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("Secret sidecar URL is invalid");
  if(process.env.NODE_ENV==="production"&&url.protocol!=="https:")throw new Error("Secret sidecar must use HTTPS in production");
  return url;
}

function validateReference(reference:string){if(Buffer.byteLength(reference,"utf8")>512||!SECRET_REFERENCE.test(reference))throw invalidSecret()}
function retryableStatus(status:number){return status===408||status===425||status===429||status>=500}
function unavailableSecret(){return new WebhookSecretResolutionError("Webhook HMAC secret is temporarily unavailable",true)}
function invalidSecret(){return new WebhookSecretResolutionError("Webhook HMAC secret is invalid",false)}
function isPlainObject(value:unknown):value is Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))return false;const prototype=Object.getPrototypeOf(value);return prototype===Object.prototype||prototype===null}
function hasControl(value:string){return Array.from(value).some(character=>{const code=character.codePointAt(0)??0;return code<32||code===127})}

async function readBounded(response:Response){
  if(!response.body)throw invalidSecret();const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const{done,value}=await reader.read();if(done)break;if(!value?.byteLength)continue;total+=value.byteLength;if(total>MAX_SECRET_BYTES){await reader.cancel().catch(()=>undefined);throw invalidSecret()}chunks.push(value)}}finally{reader.releaseLock()}
  if(!total)throw invalidSecret();const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return bytes;
}
function required(name:string){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value}
