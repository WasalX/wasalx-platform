export type ServiceClaims={iss:string;aud:string;sub:string;tenant_id:string;instance_id:string;scope:string;iat:number;exp:number;jti:string};
export class ServiceAuthenticationError extends Error{}

function decodeBase64Url(value:string){try{const normalized=value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"=");return Uint8Array.from(atob(normalized),(character)=>character.charCodeAt(0))}catch{throw new ServiceAuthenticationError("Malformed service token")}}
function decodeJson(value:string):Record<string,unknown>{try{const decoded:unknown=JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))throw new Error("object required");return decoded as Record<string,unknown>}catch{throw new ServiceAuthenticationError("Malformed service token")}}
function equalBytes(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];return mismatch===0}
function identifier(value:unknown):value is string{return typeof value==="string"&&value.length>0&&value.length<=512&&!/[\s\p{Cc}\p{Cf}]/u.test(value)}

export async function verifyServiceJwt(token:string,secret:string,requirements:{audience:string;issuer?:string;scope?:string;tenantId?:string;now?:number}){
  if(token.length>8_192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token))throw new ServiceAuthenticationError("Malformed service token");
  const parts=token.split(".");
  const header=decodeJson(parts[0]);if(header.alg!=="HS256"||header.typ!=="JWT")throw new ServiceAuthenticationError("Unsupported service token algorithm");
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${parts[0]}.${parts[1]}`)));
  if(!equalBytes(signature,decodeBase64Url(parts[2])))throw new ServiceAuthenticationError("Invalid service token signature");
  const claims=decodeJson(parts[1]);const now=Math.floor((requirements.now??Date.now())/1000);
  if(claims.iss!==(requirements.issuer??"wasalx-zammad")||claims.aud!==requirements.audience)throw new ServiceAuthenticationError("Invalid service token issuer or audience");
  if(typeof claims.iat!=="number"||typeof claims.exp!=="number"||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)||claims.iat<=0||claims.exp<=now||claims.exp<=claims.iat||claims.iat>now+30||claims.exp-claims.iat>300)throw new ServiceAuthenticationError("Expired or invalid service token lifetime");
  if(!identifier(claims.sub)||!identifier(claims.tenant_id)||!identifier(claims.instance_id)||!identifier(claims.jti)||typeof claims.scope!=="string"||!claims.scope.trim()||claims.scope.length>512||/[\p{Cc}\p{Cf}]/u.test(claims.scope))throw new ServiceAuthenticationError("Invalid service token claims");
  if(requirements.tenantId&&claims.tenant_id!==requirements.tenantId)throw new ServiceAuthenticationError("Service token tenant mismatch");
  const scopes=new Set(claims.scope.split(" "));if(requirements.scope&&!scopes.has(requirements.scope))throw new ServiceAuthenticationError("Service token scope is insufficient");
  return claims as ServiceClaims;
}

export async function signServiceJwt(claims:ServiceClaims,secret:string){const encode=(value:unknown)=>btoa(JSON.stringify(value)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");const header=encode({alg:"HS256",typ:"JWT"});const payload=encode(claims);const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const raw=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${header}.${payload}`)));const signature=btoa(String.fromCharCode(...raw)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");return`${header}.${payload}.${signature}`}
