import { Injectable, UnauthorizedException } from "@nestjs/common";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { recordAuthorizationAnomaly } from "@wasalx/observability";
import { DatabaseService } from "./database.service.js";
import { ZammadServiceSecretService } from "./zammad-service-secret.service.js";

export type ZammadClaims={tenantId:string;instanceId:string;subject:string;userId?:string;groupIds:string[];groupAdmin:boolean;membershipRevision?:number;expiresAt?:number};
export type ZammadServiceRequest={method?:string;url?:string;rawBody?:Uint8Array;headers?:Record<string,string|string[]|undefined>};
@Injectable()
export class ServiceAuthService{
  constructor(private readonly database:DatabaseService,private readonly secrets:ZammadServiceSecretService){}
  async verify(authorization:string|undefined,scope:string,request?:ZammadServiceRequest):Promise<ZammadClaims>{
    const token=bearerToken(authorization);
    if(!token){recordAuthorizationAnomaly("service_api","missing_service_token");throw new UnauthorizedException("Bearer service token is required")}
    try{
      const header=decodeProtectedHeader(token);
      if(header.alg!=="HS256"||header.typ!=="JWT")throw new Error("header");
      const candidate=decodeJwt(token);
      const tenantId=uuidClaim(candidate.tenant_id);
      const instanceId=uuidClaim(candidate.instance_id);
      if(candidate.sub!==instanceId)throw new Error("subject");
      const instances=await this.database.rows<{id:string;tenant_id:string;service_secret_reference:string}>(tenantId,
        "SELECT id,tenant_id,service_secret_reference FROM zammad_instances WHERE tenant_id=$1 AND id=$2 AND state='WORKING'",
        [tenantId,instanceId],
      );
      const instance=instances[0];
      if(!instance||instance.id!==instanceId||instance.tenant_id!==tenantId)throw new Error("instance");
      const secret=await this.secrets.resolveSigningSecret(instance.service_secret_reference,{tenantId,instanceId});
      const secretBytes=new TextEncoder().encode(secret);
      try{
        const {payload}=await jwtVerify(token,secretBytes,{issuer:"wasalx-zammad",audience:"wasalx-control",algorithms:["HS256"],clockTolerance:5});
        if(payload.tenant_id!==tenantId||payload.instance_id!==instanceId||payload.sub!==instanceId)throw new Error("binding");
        const now=Math.floor(Date.now()/1_000);
        const issuedAt=payload.iat;
        const expiresAt=payload.exp;
        if(typeof issuedAt!=="number"||typeof expiresAt!=="number"||!Number.isSafeInteger(issuedAt)||!Number.isSafeInteger(expiresAt)||expiresAt<=issuedAt||expiresAt-issuedAt>300||issuedAt>now+5)throw new Error("lifetime");
        if(typeof payload.jti!=="string"||!UUID_PATTERN.test(payload.jti))throw new Error("jti");
        if(typeof payload.scope!=="string"||payload.scope.length>512||hasControl(payload.scope))throw new Error("scope");
        const scopes=new Set(payload.scope.split(/\s+/u).filter(Boolean));
        if(!scopes.has(scope))throw new Error("scope");
        if(request)verifyRequestBinding(payload,request);
        const userId=optionalPositiveIdentifier(payload.zammad_user_id);
        const groupIds=agentGroupIds(payload,request);
        const groupAdmin=payload.zammad_group_admin===true;
        if(userId)await this.verifyMembership(tenantId,instanceId,userId,payload.zammad_membership_revision,groupAdmin);
        if(request&&request.method?.toUpperCase()!=="GET")await this.consumeMutationJti(tenantId,instanceId,payload.jti,expiresAt);
        return{tenantId,instanceId,subject:instanceId,userId,groupIds,groupAdmin,expiresAt,
          ...(typeof payload.zammad_membership_revision==="number"?{membershipRevision:payload.zammad_membership_revision}:{})};
      }finally{secretBytes.fill(0)}
    }catch{
      recordAuthorizationAnomaly("service_api","service_token_rejected");
      throw new UnauthorizedException("Invalid service token");
    }
  }

  private async verifyMembership(tenantId:string,instanceId:string,userId:string,revision:unknown,groupAdmin:boolean){
    const rows=await this.database.rows<{allowed:boolean;revision:string|number;role:string}>(tenantId,`SELECT p.revision,p.role,
      (p.sync_state='READY' AND p.revision=p.applied_revision AND p.member_state='ACTIVE' AND p.role<>'auditor'
       AND m.state='ACTIVE' AND m.role=p.role AND t.state='ACTIVE') AS allowed
      FROM native_membership_projections p JOIN tenants t ON t.id=p.tenant_id
      LEFT JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
      WHERE p.tenant_id=$1 AND p.zammad_instance_id=$2 AND p.native_user_id=$3`,[tenantId,instanceId,userId]);
    const row=rows[0];
    if(row&&(!row.allowed||!Number.isSafeInteger(revision)||revision!==Number(row.revision)))throw new Error("membership");
    if(row&&groupAdmin&&!["tenant_owner","tenant_admin"].includes(row.role))throw new Error("membership role");
    if(!row&&revision!==undefined)throw new Error("membership binding");
  }

  private async consumeMutationJti(tenantId:string,instanceId:string,jti:string,expiresAt:number){
    const accepted=await this.database.rows<{jti:string}>(tenantId,`WITH expired AS (
      DELETE FROM zammad_service_assertion_jtis WHERE tenant_id=$1 AND expires_at<now()-interval '5 seconds'
    ) INSERT INTO zammad_service_assertion_jtis (tenant_id,zammad_instance_id,jti,expires_at)
      VALUES ($1,$2,$3,to_timestamp($4)) ON CONFLICT (tenant_id,jti) DO NOTHING RETURNING jti`,[
      tenantId,instanceId,jti,expiresAt,
    ]);
    if(!accepted[0])throw new Error("service assertion replay");
  }
}

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const JWT_PATTERN=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
function bearerToken(value:string|undefined){
  if(!value||value.length>8_199||!value.startsWith("Bearer "))return undefined;
  const token=value.slice(7);
  return JWT_PATTERN.test(token)?token:undefined;
}
function uuidClaim(value:unknown){if(typeof value!=="string"||!UUID_PATTERN.test(value))throw new Error("uuid");return value}
function hasControl(value:string){return/[\p{Cc}\p{Cf}]/u.test(value)}
function optionalPositiveIdentifier(value:unknown){
  if(value===undefined)return undefined;
  if(typeof value!=="string"||!POSITIVE_IDENTIFIER.test(value))throw new Error("identifier");
  return value;
}
function positiveIdentifierList(value:unknown){
  if(value===undefined)return[];
  if(!Array.isArray(value)||value.length>100)return invalidIdentifierList();
  const identifiers=value.map(optionalPositiveIdentifier);
  if(identifiers.some(item=>item===undefined))return invalidIdentifierList();
  return[...new Set(identifiers as string[])];
}
function invalidIdentifierList():never{throw new Error("identifier list")}
const POSITIVE_IDENTIFIER=/^[1-9][0-9]{0,15}$/u;

const SHA256_PATTERN=/^[0-9a-f]{64}$/u;
const MAX_AGENT_GROUP_HEADER_BYTES=7_000;
const MAX_AGENT_GROUP_JSON_BYTES=128_000;
function verifyRequestBinding(payload:Record<string,unknown>,request:ZammadServiceRequest){
  const method=request.method?.toUpperCase();
  const target=request.url;
  if(!method||!METHOD_PATTERN.test(method)||typeof target!=="string"||target.length<1||target.length>8_192||!target.startsWith("/")||hasControl(target))throw new Error("request");
  const body=Buffer.from(request.rawBody??new Uint8Array());
  const digest=createHash("sha256").update(body).digest("hex");
  if(payload.http_method!==method||payload.http_target!==target||payload.http_body_sha256!==digest)throw new Error("request binding");
}
function agentGroupIds(payload:Record<string,unknown>,request?:ZammadServiceRequest){
  if(payload.zammad_group_ids_sha256===undefined)return positiveIdentifierList(payload.zammad_group_ids);
  if(typeof payload.zammad_group_ids_sha256!=="string"||!SHA256_PATTERN.test(payload.zammad_group_ids_sha256)||!request)throw new Error("group binding");
  const value=header(request,"x-wasalx-zammad-groups");
  if(value===undefined||Buffer.byteLength(value,"utf8")>MAX_AGENT_GROUP_HEADER_BYTES||createHash("sha256").update(value,"utf8").digest("hex")!==payload.zammad_group_ids_sha256)throw new Error("group binding");
  let parsed:unknown;
  try{
    if(!BASE64URL_PATTERN.test(value))throw new Error("group encoding");
    parsed=JSON.parse(Buffer.from(inflateSync(Buffer.from(value,"base64url"),{maxOutputLength:MAX_AGENT_GROUP_JSON_BYTES})).toString("utf8"));
  }catch{throw new Error("group binding")}
  if(!Array.isArray(parsed))return invalidIdentifierList();
  const identifiers=parsed.map(optionalPositiveIdentifier);
  if(identifiers.some(item=>item===undefined)||new Set(identifiers).size!==identifiers.length)return invalidIdentifierList();
  return identifiers as string[];
}
function header(request:ZammadServiceRequest,name:string){
  const value=request.headers?.[name]??request.headers?.[name.toLowerCase()];
  return typeof value==="string"?value:undefined;
}
const METHOD_PATTERN=/^(GET|POST)$/u;
const BASE64URL_PATTERN=/^[A-Za-z0-9_-]+$/u;
