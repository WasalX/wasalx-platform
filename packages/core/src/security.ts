export async function verifyHmac(input:{rawBody:string;secret:string;provided:string;timestamp?:string;now?:number;maxAgeSeconds?:number;algorithm?:"sha256"|"sha512";requireTimestamp?:boolean}){
  const now=input.now??Date.now();const maxAge=(input.maxAgeSeconds??300)*1000;
  if(input.requireTimestamp&&!input.timestamp)return{valid:false,reason:"timestamp" as const};
  if(input.timestamp){const parsed=Number(input.timestamp);if(!Number.isFinite(parsed)||parsed<=0)return{valid:false,reason:"timestamp" as const};const timestampMs=parsed<1e12?parsed*1000:parsed;if(Math.abs(now-timestampMs)>maxAge)return{valid:false,reason:"stale" as const}}
  const algorithm=input.algorithm??"sha256";const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(input.secret),{name:"HMAC",hash:algorithm==="sha512"?"SHA-512":"SHA-256"},false,["sign"]);
  const signed=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(input.rawBody));
  const expected=Array.from(new Uint8Array(signed)).map((b)=>b.toString(16).padStart(2,"0")).join("");
  const provided=input.provided.replace(/^sha(?:256|512)=/i,"").toLowerCase();if(!/^[0-9a-f]+$/.test(provided)||expected.length!==provided.length)return{valid:false,reason:"signature" as const};let mismatch=0;for(let i=0;i<expected.length;i++)mismatch|=expected.charCodeAt(i)^provided.charCodeAt(i);return mismatch===0?{valid:true as const}:{valid:false,reason:"signature" as const};
}
