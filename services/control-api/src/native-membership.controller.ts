import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, Param, Post, Req, SetMetadata } from "@nestjs/common";
import { appendAudit } from "./audit.js";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { DatabaseService } from "./database.service.js";
import { NativeMembershipService, type NativeMembership } from "./native-membership.service.js";
import { Requires } from "./permission.guard.js";
import { authoritativeMfaPolicy, requirePrivilegedAuthentication } from "./privileged-auth.js";
import { isTenantRole, tenantRoles } from "./rbac.js";
import { ServiceAuthService,type ZammadServiceRequest } from "./service-auth.service.js";
import type { AuthenticatedRequest } from "./types.js";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type NativeAuthenticationRow = {
  native_user_id: string; oidc_subject: string; role: string; active_mfa_required_roles: unknown;
  active_session_timeout_minutes: number | string; policy_version: number | string;
};

function nativeAuthenticationPolicy(row: NativeAuthenticationRow | undefined) {
  if (!row || !isTenantRole(row.role) || !Array.isArray(row.active_mfa_required_roles)
    || row.active_mfa_required_roles.length < 1 || row.active_mfa_required_roles.length > tenantRoles.length
    || !row.active_mfa_required_roles.every(isTenantRole)
    || typeof row.oidc_subject !== "string" || row.oidc_subject !== row.oidc_subject.trim()
    || !row.oidc_subject.length || row.oidc_subject.length > 320 || /[\p{Cc}\p{Cf}]/u.test(row.oidc_subject)
    || typeof row.native_user_id !== "string" || !/^[1-9][0-9]{0,15}$/u.test(row.native_user_id) || !Number.isSafeInteger(Number(row.native_user_id))) return undefined;
  const integer = (value: unknown) => typeof value === "number" || typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value) ? Number(value) : NaN;
  const sessionMinutes = integer(row.active_session_timeout_minutes), version = integer(row.policy_version);
  if (!Number.isSafeInteger(sessionMinutes) || sessionMinutes < 15 || sessionMinutes > 1440
    || !Number.isSafeInteger(version) || version < 1) return undefined;
  const mfaPolicy = authoritativeMfaPolicy();
  return mfaPolicy ? { mfa_required: row.active_mfa_required_roles.includes(row.role), session_timeout_minutes: sessionMinutes,
    policy_version: version, subject: row.oidc_subject, ...mfaPolicy } : undefined;
}

@Controller("v1/team/workspace-access")
export class NativeMembershipController {
  constructor(private readonly database:DatabaseService,private readonly sync:NativeMembershipService){}
  @Get() @Requires("team:read")
  async status(@Req()request:AuthenticatedRequest){
    const tenantId=request.principal.tenantId;
    const settings=(await this.database.rows<{native_membership_sync_enabled:boolean}>(tenantId,"SELECT native_membership_sync_enabled FROM tenant_settings WHERE tenant_id=$1",[tenantId]))[0];
    const members=await this.database.rows<Pick<NativeMembership,"user_id"|"native_user_id"|"revision"|"applied_revision"|"sync_state"|"member_state">>(tenantId,"SELECT user_id,native_user_id,revision,applied_revision,sync_state,member_state FROM native_membership_projections WHERE tenant_id=$1 ORDER BY user_id",[tenantId]);
    const captured=new Map(members.map(({user_id,...identity})=>[user_id,identity]));
    const observations=members.length?await this.sync.observe(tenantId,members.map(member=>member.user_id),captured):new Map();
    return{enabled:settings?.native_membership_sync_enabled===true,members:members.map(member=>({...member,nativeObservation:observations.get(String(member.user_id))}))};
  }
  @Post("enable") @Requires("team:write")
  async enable(@Req()request:AuthenticatedRequest){
    this.owner(request);
    await this.database.withTenant(request.principal.tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,"enabling workspace account synchronization");
      const settings=await client.query<{enabled:boolean}>("SELECT app.enable_native_membership_sync($1) AS enabled",[request.principal.userId]);
      if(settings.rows[0]?.enabled){
        await appendAudit(client,request.principal,{action:"team.native_access_enabled",targetType:"tenant",targetId:request.principal.tenantId,requestId:String(request.id),newValue:{enabled:true}});
      }
    });
    this.sync.wake(request.principal.tenantId);
    return this.status(request);
  }
  @Get(":userId/candidates") @Requires("team:write")
  async candidates(@Req()request:AuthenticatedRequest,@Param("userId")userId:string){this.owner(request);this.user(userId);return{candidates:await this.sync.candidates(request.principal.tenantId,userId)};}
  @Post(":userId/reconcile") @Requires("team:write")
  async reconcile(@Req()request:AuthenticatedRequest,@Param("userId")userId:string,@Body()body:{expectedRevision?:number;adoptUserId?:string;prerequisiteChange?:string}){
    this.owner(request);this.user(userId);
    if(!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<1)throw new BadRequestException("Workspace access revision is required");
    if(body.adoptUserId!==undefined&&!/^[1-9][0-9]{0,15}$/u.test(body.adoptUserId))throw new BadRequestException("Select a workspace account");
    await this.database.withTenant(request.principal.tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,"reconciling a workspace account");
      const row=(await client.query<NativeMembership>("SELECT * FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",[request.principal.tenantId,userId])).rows[0];
      if(!row||Number(row.revision)!==body.expectedRevision)throw new ConflictException("Workspace access changed; reload before continuing");
      if(row.sync_state==="PROTECTED")throw new ConflictException("The privileged workspace account is managed separately");
      if(body.adoptUserId&&(row.native_user_id||row.sync_state!=="ADOPTION_REQUIRED"))throw new ConflictException("This identity cannot adopt another workspace account");
      if(row.sync_state==="READY")return;
      if(row.sync_state==="PENDING")throw new ConflictException("Workspace synchronization is already pending");
      if(!body.adoptUserId&&(typeof body.prerequisiteChange!=="string"||body.prerequisiteChange.trim().length<8||body.prerequisiteChange.length>240||/[\p{Cc}\p{Cf}]/u.test(body.prerequisiteChange)))throw new BadRequestException("Describe the prerequisite that changed before reconciling");
      await client.query(`UPDATE native_membership_projections SET requested_native_user_id=COALESCE($3,requested_native_user_id),
        revision=revision+1,sync_state='PENDING',updated_at=now() WHERE tenant_id=$1 AND user_id=$2`,[request.principal.tenantId,userId,body.adoptUserId??null]);
      await appendAudit(client,request.principal,{action:body.adoptUserId?"team.native_account_adoption_requested":"team.native_access_reconcile_requested",targetType:"user",targetId:userId,requestId:String(request.id),newValue:{native_user_id:body.adoptUserId??row.native_user_id,revision:Number(row.revision),prerequisite_change:body.prerequisiteChange?.trim()??null}});
    });
    this.sync.wake(request.principal.tenantId);return this.status(request);
  }
  private owner(request:AuthenticatedRequest){if(request.principal.role!=="tenant_owner")throw new ForbiddenException("Only a workspace owner can link native accounts");}
  private user(value:string){if(!UUID.test(value))throw new BadRequestException("Member identity is invalid");}
}

@Controller("internal/v1/zammad/membership")
@SetMetadata(PUBLIC_ROUTE,true)
export class NativeMembershipInternalController {
  constructor(private readonly database:DatabaseService,private readonly auth:ServiceAuthService){}
  @Post("retired")
  async retired(@Headers("authorization")authorization:string|undefined,@Body()body:{subject?:string},@Req()request?:ZammadServiceRequest){
    const claims=await this.auth.verify(authorization,"zammad:membership",request);
    if(typeof body.subject!=="string"||!body.subject.trim()||body.subject.length>320||/[\p{Cc}\p{Cf}]/u.test(body.subject))throw new BadRequestException("Identity is invalid");
    const row=(await this.database.rows<{retired:boolean}>(claims.tenantId,`SELECT NOT EXISTS (
      SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND u.oidc_subject=$2 AND m.state<>'REMOVED'
    ) AS retired`,[claims.tenantId,body.subject]))[0];
    return{retired:row?.retired===true};
  }
  @Post("identity")
  async identity(@Headers("authorization")authorization:string|undefined,@Body()body:{subject?:string},@Req()request?:ZammadServiceRequest){
    const claims=await this.auth.verify(authorization,"zammad:membership",request);
    if(typeof body.subject!=="string"||!body.subject.trim()||body.subject.length>320||/[\p{Cc}\p{Cf}]/u.test(body.subject))throw new BadRequestException("Identity is invalid");
    const setting=(await this.database.rows<{native_membership_sync_enabled:boolean;state:string}>(claims.tenantId,"SELECT s.native_membership_sync_enabled,t.state FROM tenant_settings s JOIN tenants t ON t.id=s.tenant_id WHERE s.tenant_id=$1",[claims.tenantId]))[0];
    if(setting?.state!=="ACTIVE")return{enabled:true,native_user_id:null};
    if(!setting.native_membership_sync_enabled)return{enabled:false};
    const row=(await this.database.rows<NativeAuthenticationRow>(claims.tenantId,`SELECT p.native_user_id,u.oidc_subject,m.role,
      s.active_mfa_required_roles,s.active_session_timeout_minutes,s.version AS policy_version FROM native_membership_projections p
      JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
      JOIN users u ON u.id=p.user_id JOIN tenants t ON t.id=p.tenant_id JOIN tenant_settings s ON s.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.zammad_instance_id=$2 AND p.oidc_subject=$3 AND p.member_state='ACTIVE' AND p.role<>'auditor'
        AND p.sync_state='READY' AND p.revision=p.applied_revision AND m.state='ACTIVE' AND m.role=p.role
        AND u.oidc_subject=p.oidc_subject AND t.state='ACTIVE' AND s.native_membership_sync_enabled`,[claims.tenantId,claims.instanceId,body.subject]))[0];
    const policy = nativeAuthenticationPolicy(row);
    return policy ? {enabled:true,native_user_id:row!.native_user_id,authentication_policy:policy} : {enabled:true,native_user_id:null};
  }
  @Post("bootstrap-check")
  async bootstrapCheck(@Headers("authorization") authorization:string|undefined,
    @Body() body:{user_id?:string;native_user_id?:string;revision?:number;subject?:string;email?:string}, @Req() request?:ZammadServiceRequest) {
    const claims = await this.auth.verify(authorization,"zammad:membership",request);
    if (!body.user_id || !UUID.test(body.user_id) || !body.native_user_id || !/^[1-9][0-9]{0,15}$/u.test(body.native_user_id)
      || !Number.isSafeInteger(body.revision) || typeof body.subject !== "string" || typeof body.email !== "string") throw new BadRequestException("Identity is invalid");
    const row = (await this.database.rows<NativeAuthenticationRow & {user_id:string;email:string;display_name:string;revision:number;privileged_reauth_minutes:number}>(claims.tenantId, `SELECT $6::text AS native_user_id,
      p.user_id,u.oidc_subject,p.email,p.display_name,p.revision,m.role,s.active_mfa_required_roles,s.active_session_timeout_minutes,
      s.privileged_reauth_minutes,s.version AS policy_version FROM native_membership_projections p
      JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id JOIN users u ON u.id=p.user_id
      JOIN tenants t ON t.id=p.tenant_id JOIN tenant_settings s ON s.tenant_id=p.tenant_id
      JOIN zammad_instances z ON z.tenant_id=p.tenant_id AND z.id=p.zammad_instance_id
      WHERE p.tenant_id=$1 AND p.zammad_instance_id=$2 AND p.user_id=$3 AND p.revision=$4 AND p.oidc_subject=$5
        AND p.email=$7 AND p.email=u.email AND u.oidc_subject=p.oidc_subject AND m.role='tenant_owner' AND p.role=m.role
        AND m.state='ACTIVE' AND p.member_state='ACTIVE' AND t.state='ACTIVE' AND z.state='WORKING'
        AND s.native_membership_sync_enabled AND p.sync_state='PROTECTED' AND p.native_user_id IS NULL
        AND p.applied_revision=0 AND p.requested_native_user_id IS NULL`,
      [claims.tenantId,claims.instanceId,body.user_id,body.revision,body.subject,body.native_user_id,body.email]))[0];
    const policy = nativeAuthenticationPolicy(row), minutes = Number(row?.privileged_reauth_minutes);
    if (!policy || !Number.isSafeInteger(minutes) || minutes < 5 || minutes > 120 || !process.env.OIDC_ISSUER || !process.env.OIDC_AUDIENCE) return {allowed:false};
    return {allowed:true,authentication_policy:policy,privileged_reauth_minutes:minutes,
      portal_source:{issuer:process.env.OIDC_ISSUER,audience:process.env.OIDC_AUDIENCE},projection:{action:"APPLY",tenant_id:claims.tenantId,
        instance_id:claims.instanceId,user_id:row!.user_id,subject:row!.oidc_subject,email:row!.email,name:row!.display_name,
        role:"tenant_owner",state:"ACTIVE",revision:Number(row!.revision),native_user_id:null,adopt_user_id:null}};
  }
  @Post("check")
  async check(@Headers("authorization")authorization:string|undefined,@Body()body:{user_id?:string;native_user_id?:string;revision?:number;privileged?:boolean},@Req()request?:ZammadServiceRequest){
    const claims=await this.auth.verify(authorization,"zammad:membership",request);
    if(!body.user_id||!UUID.test(body.user_id)||!body.native_user_id||!/^[1-9][0-9]{0,15}$/u.test(body.native_user_id)||!Number.isSafeInteger(body.revision)||(body.privileged!==undefined&&typeof body.privileged!=="boolean"))throw new BadRequestException("Membership check is invalid");
    const row=(await this.database.rows<NativeAuthenticationRow & {allowed:boolean;privileged_reauth_minutes:number|string}>(claims.tenantId,`SELECT (p.member_state='ACTIVE' AND p.role<>'auditor' AND p.sync_state='READY'
      AND p.revision=p.applied_revision AND p.revision=$5 AND m.state='ACTIVE' AND m.role=p.role AND t.state='ACTIVE'
      AND u.oidc_subject=p.oidc_subject AND p.email=u.email AND s.native_membership_sync_enabled) AS allowed,
      p.native_user_id,u.oidc_subject,m.role,s.active_mfa_required_roles,s.active_session_timeout_minutes,s.privileged_reauth_minutes,s.version AS policy_version
      FROM native_membership_projections p LEFT JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
      JOIN users u ON u.id=p.user_id JOIN tenants t ON t.id=p.tenant_id JOIN tenant_settings s ON s.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.zammad_instance_id=$2 AND p.user_id=$3 AND p.native_user_id=$4`,[claims.tenantId,claims.instanceId,body.user_id,body.native_user_id,body.revision]))[0];
    const policy = row?.allowed === true ? nativeAuthenticationPolicy(row) : undefined;
    const value = row?.privileged_reauth_minutes;
    const minutes = typeof value === "number" || typeof value === "string" && /^[1-9][0-9]{0,2}$/u.test(value) ? Number(value) : NaN;
    if (body.privileged === true && (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 120)) return {allowed:false};
    return policy ? {allowed:true,authentication_policy:policy,...(body.privileged === true ? {privileged_reauth_minutes:minutes} : {}),...(process.env.OIDC_ISSUER&&process.env.OIDC_AUDIENCE?{portal_source:{issuer:process.env.OIDC_ISSUER,audience:process.env.OIDC_AUDIENCE}}:{})} : {allowed:false};
  }
}
