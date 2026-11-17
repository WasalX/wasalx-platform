export type HmacAlgorithm="sha256"|"sha512";
export const META_WEBHOOK_MAX_BYTES=3_000_000;
type WebhookBytes=string|Uint8Array;

export async function sha256Hex(value:WebhookBytes){const digest=await crypto.subtle.digest("SHA-256",bytes(value));return hex(new Uint8Array(digest))}

export async function verifyProviderHmac(input:{rawBody:WebhookBytes;secret:string;provided:string;algorithm:HmacAlgorithm;timestamp?:string;now?:number;maxAgeSeconds?:number;requireTimestamp?:boolean}){
  if(input.requireTimestamp&&!input.timestamp)return{valid:false,reason:"timestamp" as const};
  if(input.timestamp){const freshness=verifyWebhookTimestamp(input.timestamp,input.now,input.maxAgeSeconds);if(!freshness.valid)return freshness}
  const provided=input.provided.replace(/^sha(?:256|512)=/i,"").toLowerCase();const expectedLength=input.algorithm==="sha512"?128:64;if(!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(provided))return{valid:false,reason:"signature" as const};
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(input.secret),{name:"HMAC",hash:input.algorithm==="sha512"?"SHA-512":"SHA-256"},false,["sign"]);const signature=new Uint8Array(await crypto.subtle.sign("HMAC",key,bytes(input.rawBody)));const expected=hex(signature);let mismatch=0;for(let index=0;index<expected.length;index++)mismatch|=expected.charCodeAt(index)^provided.charCodeAt(index);return mismatch===0?{valid:true as const}:{valid:false,reason:"signature" as const}
}

export function verifyWebhookTimestamp(timestamp:string,now=Date.now(),maxAgeSeconds=300){const numeric=Number(timestamp);const parsed=Number.isFinite(numeric)&&numeric>0?(numeric<1e12?numeric*1000:numeric):Date.parse(timestamp);if(!Number.isFinite(parsed)||parsed<=0)return{valid:false,reason:"timestamp" as const};return Math.abs(now-parsed)>(maxAgeSeconds*1000)?{valid:false,reason:"stale" as const}:{valid:true as const}}

function hex(value:Uint8Array){return Array.from(value,byte=>byte.toString(16).padStart(2,"0")).join("")}
function bytes(value:WebhookBytes){return typeof value==="string"?new TextEncoder().encode(value):Uint8Array.from(value)}
