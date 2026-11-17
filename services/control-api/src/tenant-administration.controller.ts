import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  GoneException,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { appendAudit } from "./audit.js";
import { AuthService } from "./auth.service.js";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { DatabaseService } from "./database.service.js";
import { InvitationTokenService } from "./invitation-token.service.js";
import { NativeMembershipService } from "./native-membership.service.js";
import { Requires } from "./permission.guard.js";
import type { TenantRole } from "./rbac.js";
import type { AuthenticatedRequest } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;
const ROLES = new Set<TenantRole>(["tenant_owner", "tenant_admin", "supervisor", "agent", "auditor"]);
const THEMES = new Set(["LIGHT", "DARK", "SYSTEM"]);

type WorkspaceInput = {
  expectedVersion?: number;
  name?: string;
  slug?: string;
  accentColor?: string;
  defaultTheme?: string;
  groupDisclosureEnabled?: boolean;
  groupDisclosureMessage?: string;
  ssoEnforcementRequested?: boolean;
  ssoProviderName?: string | null;
  ssoIssuer?: string | null;
  ssoEmailDomains?: string[];
  mfaRequiredRoles?: string[];
  sessionTimeoutMinutes?: number;
  privilegedReauthMinutes?: number;
  supportAccessRequiresApproval?: boolean;
};

type MemberRow = {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: TenantRole;
  state: "ACTIVE" | "SUSPENDED";
  whatsapp_numbers: string[];
  version: string | number;
  created_at: string;
  updated_at: string;
};

type InvitationRow = {
  id: string;
  email: string;
  display_name: string | null;
  role: TenantRole;
  state: string;
  expires_at: string;
  version: string | number;
  created_at: string;
  updated_at: string;
  delivery_state?: string | null;
  delivery_attempts?: number | null;
  delivery_error_code?: string | null;
  delivery_error?: string | null;
  delivery_updated_at?: string | null;
};

@Controller("v1")
export class TenantAdministrationController {
  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: InvitationTokenService,
    private readonly auth: AuthService,
    private readonly nativeMembership: NativeMembershipService,
  ) {}

  @Get("settings/workspace")
  @Requires("settings:read")
  async workspace(@Req() request: AuthenticatedRequest) {
    const row = (await this.database.rows<Record<string, unknown>>(
      request.principal.tenantId,
      `SELECT t.id,t.name,t.slug,t.state,s.accent_color,s.default_theme,
              s.group_disclosure_enabled,s.group_disclosure_message,
              s.sso_enforcement_state,s.sso_provider_name,s.sso_issuer,s.sso_email_domains,
              s.mfa_required_roles,s.session_timeout_minutes,
              s.privileged_reauth_minutes,s.support_access_requires_approval,
              s.security_policy_state,s.policy_verified_at,
              s.policy_verification_evidence_sha256,s.version,s.updated_at
         FROM tenants t
         JOIN tenant_settings s ON s.tenant_id=t.id
        WHERE t.id=$1`,
      [request.principal.tenantId],
    ))[0];
    if (!row) throw new NotFoundException("Workspace settings were not found");
    return row;
  }

  @Put("settings/workspace")
  @Requires("settings:write")
  async updateWorkspace(@Req() request: AuthenticatedRequest, @Body() body: WorkspaceInput) {
    if (request.principal.role !== "tenant_owner") {
      throw new ForbiddenException("Only a tenant owner can change workspace and identity policy");
    }
    const input = validateWorkspace(body);
    try {
      return await this.database.withTenant(request.principal.tenantId, async (client) => {
        const previous = (await client.query<Record<string, unknown>>(
          `SELECT t.name,t.slug,s.accent_color,s.default_theme,
                  s.group_disclosure_enabled,s.group_disclosure_message,
                  s.sso_enforcement_state,s.sso_provider_name,s.sso_issuer,s.sso_email_domains,
                  s.mfa_required_roles,s.session_timeout_minutes,
                  s.privileged_reauth_minutes,s.support_access_requires_approval,
                  s.security_policy_state,s.policy_verified_at,
                  s.policy_verification_evidence_sha256,s.version,s.updated_at
             FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id
            WHERE t.id=$1`,
          [request.principal.tenantId],
        )).rows[0];
        if (!previous) throw new NotFoundException("Workspace settings were not found");
        const updated = (await client.query<Record<string, unknown>>(
          `SELECT * FROM app.update_tenant_workspace(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
           )`,
          [
            input.expectedVersion,
            input.name,
            input.slug,
            input.accentColor,
            input.defaultTheme,
            input.groupDisclosureEnabled,
            input.groupDisclosureMessage,
            input.ssoEnforcementRequested,
            input.ssoProviderName,
            input.ssoIssuer,
            input.ssoEmailDomains,
            input.mfaRequiredRoles,
            input.sessionTimeoutMinutes,
            input.privilegedReauthMinutes,
            input.supportAccessRequiresApproval,
            request.principal.userId,
          ],
        )).rows[0];
        if (!updated) throw new ConflictException("The workspace changed; reload before saving");
        await appendAudit(client, request.principal, {
          action: "settings.workspace_updated",
          targetType: "tenant",
          targetId: request.principal.tenantId,
          requestId: String(request.id),
          previousValue: previous,
          newValue: updated,
        });
        return updated;
      });
    } catch (error) {
      const code = postgresCode(error);
      if (code === "40001") throw new ConflictException("The workspace changed; reload before saving");
      if (code === "23505") throw new ConflictException("That workspace slug is already in use");
      throw error;
    }
  }

  @Get("team")
  @Requires("team:read")
  async team(@Req() request: AuthenticatedRequest) {
    const members = await this.database.rows<MemberRow>(
      request.principal.tenantId,
      `SELECT m.id,m.user_id,u.email,u.display_name,m.role,m.state,m.version,m.whatsapp_numbers,
              m.created_at,m.updated_at
         FROM tenant_memberships m
         JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=$1
        ORDER BY CASE m.role
          WHEN 'tenant_owner' THEN 1 WHEN 'tenant_admin' THEN 2
          WHEN 'supervisor' THEN 3 WHEN 'agent' THEN 4 ELSE 5 END,
          lower(u.display_name),m.id`,
      [request.principal.tenantId],
    );
    const canManage = request.principal.role === "tenant_owner" || request.principal.role === "tenant_admin";
    const invitations = canManage
      ? await this.database.rows<InvitationRow>(
          request.principal.tenantId,
          `SELECT invitation.id,invitation.email,invitation.display_name,invitation.role,
                  CASE WHEN invitation.state='PENDING' AND invitation.expires_at<=now()
                    THEN 'EXPIRED' ELSE invitation.state END AS state,
                  invitation.expires_at,invitation.version,invitation.created_at,invitation.updated_at,
                  delivery.state AS delivery_state,delivery.attempts AS delivery_attempts,
                  delivery.error_code AS delivery_error_code,delivery.safe_error AS delivery_error,
                  delivery.updated_at AS delivery_updated_at
             FROM tenant_invitations invitation
        LEFT JOIN LATERAL (
                  SELECT state,attempts,error_code,safe_error,updated_at
                    FROM tenant_invitation_email_outbox
                   WHERE tenant_id=invitation.tenant_id AND invitation_id=invitation.id
                   ORDER BY created_at DESC,id DESC LIMIT 1
                ) delivery ON true
            WHERE invitation.tenant_id=$1
            ORDER BY invitation.created_at DESC
            LIMIT 200`,
          [request.principal.tenantId],
        )
      : [];
    const captured=new Map(members.map(member=>[member.user_id,{email:member.email,display_name:member.display_name,role:member.role,member_state:member.state}]));
    const observations=members.length&&this.nativeMembership?await this.nativeMembership.observe(request.principal.tenantId,members.map(member=>member.user_id),captured):new Map();
    return {
      members: members.map((member) => ({
        ...member,
        nativeObservation:observations.get(member.user_id),
        version: Number(member.version),
        is_current_user: member.user_id === request.principal.userId,
      })),
      invitations: invitations.map((invitation) => ({
        ...invitation,
        version: Number(invitation.version),
        delivery_error_code: publicInvitationDeliveryCode(invitation.delivery_error_code),
      })),
      capabilities: {
        can_invite: canManage,
        can_manage_members: canManage,
        can_manage_owners: request.principal.role === "tenant_owner",
      },
    };
  }

  @Post("team/invitations")
  @Requires("team:invite")
  async invite(
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyHeader: string | undefined,
    @Body() body: { email?: string; displayName?: string; role?: string; expiresInDays?: number },
  ) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const input = validateInvite(body);
    assertCanAssignRole(request.principal.role, input.role);
    const requestHash = canonicalHash({ action: "INVITE", ...input });
    return this.database.withTenant(request.principal.tenantId, async (client) => {
      await lockIdempotency(client, request.principal.tenantId, idempotencyKey);
      const replay = (await client.query<InvitationRow & { request_sha256: string }>(
        `SELECT invitation.id,invitation.email,invitation.display_name,invitation.role,
                invitation.state,invitation.expires_at,invitation.version,
                invitation.created_at,invitation.updated_at,
                delivery.state AS delivery_state,delivery.error_code AS delivery_error_code,
                delivery.request_sha256
           FROM tenant_invitation_email_outbox delivery
           JOIN tenant_invitations invitation
             ON invitation.tenant_id=delivery.tenant_id AND invitation.id=delivery.invitation_id
          WHERE delivery.tenant_id=$1 AND delivery.idempotency_key=$2`,
        [request.principal.tenantId, idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.request_sha256 !== requestHash) {
          throw new ConflictException("The idempotency key was already used for another invitation request");
        }
        return invitationResponse(replay, true);
      }

      const expired = (await client.query<{ id: string; version: string | number }>(
        `UPDATE tenant_invitations SET state='EXPIRED',version=version+1,updated_at=now()
          WHERE tenant_id=$1 AND email=$2 AND state='PENDING' AND expires_at<=now()
          RETURNING id,version`,
        [request.principal.tenantId, input.email],
      )).rows;
      for (const item of expired) {
        await appendAudit(client, request.principal, {
          action: "team.invitation_expired",
          targetType: "tenant_invitation",
          targetId: item.id,
          requestId: String(request.id),
          previousValue: { state: "PENDING" },
          newValue: { state: "EXPIRED", version: Number(item.version) },
        });
      }
      const existingMember = (await client.query<{ id: string }>(
        `SELECT m.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.tenant_id=$1 AND lower(u.email)=$2 LIMIT 1`,
        [request.principal.tenantId, input.email],
      )).rows[0];
      if (existingMember) throw new ConflictException("This person already belongs to the workspace");
      const pending = (await client.query<{ id: string }>(
        `SELECT id FROM tenant_invitations
          WHERE tenant_id=$1 AND email=$2 AND state='PENDING' LIMIT 1`,
        [request.principal.tenantId, input.email],
      )).rows[0];
      if (pending) throw new ConflictException("A pending invitation already exists; resend or revoke it instead");

      const envelope = this.tokens.issue();
      const invitation = (await client.query<InvitationRow>(
        `INSERT INTO tenant_invitations (
           tenant_id,email,display_name,role,token_hash,expires_at,invited_by,
           create_idempotency_key,create_request_sha256
         ) VALUES ($1,$2,$3,$4,$5,now()+make_interval(days=>$6),$7,$8,$9)
         RETURNING id,email,display_name,role,state,expires_at,version,created_at,updated_at`,
        [
          request.principal.tenantId,input.email,input.displayName,input.role,
          envelope.tokenHash,input.expiresInDays,request.principal.userId,idempotencyKey,requestHash,
        ],
      )).rows[0]!;
      const delivery = (await client.query<{ state: string }>(
        `INSERT INTO tenant_invitation_email_outbox (
           tenant_id,invitation_id,action,recipient_email,token_ciphertext,
           token_key_version,idempotency_key,request_sha256
         ) VALUES ($1,$2,'INVITE',$3,$4,$5,$6,$7)
         RETURNING state`,
        [
          request.principal.tenantId,invitation.id,input.email,envelope.ciphertext,
          envelope.keyVersion,idempotencyKey,requestHash,
        ],
      )).rows[0]!;
      await appendAudit(client, request.principal, {
        action: "team.invitation_created",
        targetType: "tenant_invitation",
        targetId: invitation.id,
        requestId: String(request.id),
        newValue: { email: input.email, role: input.role, state: invitation.state, expires_at: invitation.expires_at, delivery_state: delivery.state },
      });
      return invitationResponse({ ...invitation, delivery_state: delivery.state }, false);
    });
  }

  @Post("team/invitations/:id/resend")
  @Requires("team:invite")
  async resend(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyHeader: string | undefined,
    @Body() body: { expiresInDays?: number; confirmUnknownDelivery?: boolean },
  ) {
    assertUuid(id, "Invitation ID");
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const expiresInDays = integerRange(body.expiresInDays ?? 7, 1, 30, "Invitation expiry");
    if (body.confirmUnknownDelivery !== undefined && typeof body.confirmUnknownDelivery !== "boolean") {
      throw new BadRequestException("Unknown delivery confirmation must be a boolean");
    }
    const confirmUnknownDelivery = body.confirmUnknownDelivery === true;
    const requestHash = canonicalHash({ action: "RESEND", invitationId: id, expiresInDays, confirmUnknownDelivery });
    return this.database.withTenant(request.principal.tenantId, async (client) => {
      await lockIdempotency(client, request.principal.tenantId, idempotencyKey);
      const replay = (await client.query<InvitationRow & { request_sha256: string }>(
        `SELECT invitation.id,invitation.email,invitation.display_name,invitation.role,
                invitation.state,invitation.expires_at,invitation.version,
                invitation.created_at,invitation.updated_at,
                delivery.state AS delivery_state,delivery.error_code AS delivery_error_code,
                delivery.request_sha256
           FROM tenant_invitation_email_outbox delivery
           JOIN tenant_invitations invitation
             ON invitation.tenant_id=delivery.tenant_id AND invitation.id=delivery.invitation_id
          WHERE delivery.tenant_id=$1 AND delivery.idempotency_key=$2`,
        [request.principal.tenantId, idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.request_sha256 !== requestHash || replay.id !== id) {
          throw new ConflictException("The idempotency key was already used for another invitation request");
        }
        return invitationResponse(replay, true);
      }
      const previous = (await client.query<InvitationRow>(
        `SELECT id,email,display_name,role,state,expires_at,version,created_at,updated_at
           FROM tenant_invitations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [request.principal.tenantId, id],
      )).rows[0];
      if (!previous) throw new NotFoundException("Invitation not found");
      assertCanManageInvitation(request.principal.role, previous.role);
      if (previous.state === "ACCEPTED" || previous.state === "REVOKED") {
        throw new ConflictException(`A ${previous.state.toLowerCase()} invitation cannot be resent`);
      }
      const activeDeliveries = await lockActiveInvitationDeliveries(client, request.principal.tenantId, id);
      if (activeDeliveries.some((delivery) => delivery.state === "SENDING")) {
        throw new ConflictException("Invitation delivery is already in progress");
      }
      const latestDelivery = (await client.query<{ state: string; error_code: string | null }>(
        `SELECT state,error_code
           FROM tenant_invitation_email_outbox
          WHERE tenant_id=$1 AND invitation_id=$2
          ORDER BY created_at DESC,id DESC LIMIT 1`,
        [request.principal.tenantId, id],
      )).rows[0];
      const unknownDelivery = latestDelivery?.state === "FAILED_TERMINAL" && [
        "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN",
        "EMAIL_PROVIDER_RECEIPT_PERSISTENCE_UNKNOWN",
      ].includes(latestDelivery.error_code ?? "");
      if (unknownDelivery && !confirmUnknownDelivery) {
        throw new ConflictException("Check the destination mailbox, then explicitly confirm the resend");
      }
      const envelope = this.tokens.issue();
      const updated = (await client.query<InvitationRow>(
        `UPDATE tenant_invitations
            SET token_hash=$3,state='PENDING',expires_at=now()+make_interval(days=>$4),
                version=version+1,updated_at=now()
          WHERE tenant_id=$1 AND id=$2
          RETURNING id,email,display_name,role,state,expires_at,version,created_at,updated_at`,
        [request.principal.tenantId, id, envelope.tokenHash, expiresInDays],
      )).rows[0]!;
      await client.query(
        `UPDATE tenant_invitation_email_outbox
            SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE tenant_id=$1 AND invitation_id=$2
            AND state IN ('PENDING','FAILED_RETRYABLE')`,
        [request.principal.tenantId, id],
      );
      const delivery = (await client.query<{ state: string }>(
        `INSERT INTO tenant_invitation_email_outbox (
           tenant_id,invitation_id,action,recipient_email,token_ciphertext,
           token_key_version,idempotency_key,request_sha256
         ) VALUES ($1,$2,'RESEND',$3,$4,$5,$6,$7)
         RETURNING state`,
        [
          request.principal.tenantId,id,updated.email,envelope.ciphertext,
          envelope.keyVersion,idempotencyKey,requestHash,
        ],
      )).rows[0]!;
      await appendAudit(client, request.principal, {
        action: "team.invitation_resent",
        targetType: "tenant_invitation",
        targetId: id,
        requestId: String(request.id),
        previousValue: { state: previous.state, expires_at: previous.expires_at, version: Number(previous.version), delivery_state: latestDelivery?.state, delivery_error_code: latestDelivery?.error_code },
        newValue: { state: updated.state, expires_at: updated.expires_at, version: Number(updated.version), delivery_state: delivery.state, unknown_delivery_confirmed: unknownDelivery && confirmUnknownDelivery },
      });
      return invitationResponse({ ...updated, delivery_state: delivery.state }, false);
    });
  }

  @Post("team/invitations/:id/revoke")
  @Requires("team:invite")
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { expectedVersion?: number },
  ) {
    assertUuid(id, "Invitation ID");
    const expectedVersion = positiveInteger(body.expectedVersion, "Invitation version");
    return this.database.withTenant(request.principal.tenantId, async (client) => {
      const previous = (await client.query<InvitationRow>(
        `SELECT id,email,display_name,role,state,expires_at,version,created_at,updated_at
           FROM tenant_invitations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [request.principal.tenantId, id],
      )).rows[0];
      if (!previous) throw new NotFoundException("Invitation not found");
      assertCanManageInvitation(request.principal.role, previous.role);
      if (Number(previous.version) !== expectedVersion) {
        throw new ConflictException("The invitation changed; reload before revoking it");
      }
      if (previous.state === "ACCEPTED") throw new ConflictException("An accepted invitation cannot be revoked");
      if (previous.state === "REVOKED") return invitationResponse(previous, true);
      const activeDeliveries = await lockActiveInvitationDeliveries(client, request.principal.tenantId, id);
      if (activeDeliveries.some((delivery) => delivery.state === "SENDING")) {
        throw new ConflictException("Invitation delivery is already in progress");
      }
      const updated = (await client.query<InvitationRow>(
        `UPDATE tenant_invitations
            SET state='REVOKED',revoked_by=$3,revoked_at=now(),version=version+1,updated_at=now()
          WHERE tenant_id=$1 AND id=$2
          RETURNING id,email,display_name,role,state,expires_at,version,created_at,updated_at`,
        [request.principal.tenantId, id, request.principal.userId],
      )).rows[0]!;
      await client.query(
        `UPDATE tenant_invitation_email_outbox
            SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE tenant_id=$1 AND invitation_id=$2
            AND state IN ('PENDING','FAILED_RETRYABLE')`,
        [request.principal.tenantId, id],
      );
      await appendAudit(client, request.principal, {
        action: "team.invitation_revoked",
        targetType: "tenant_invitation",
        targetId: id,
        requestId: String(request.id),
        previousValue: { state: previous.state, version: Number(previous.version) },
        newValue: { state: updated.state, version: Number(updated.version) },
      });
      return invitationResponse(updated, false);
    });
  }

  @Patch("team/members/:id")
  @Requires("team:write")
  async updateMember(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { role?: string; state?: string; expectedVersion?: number; whatsappNumbers?: unknown },
  ) {
    assertUuid(id, "Membership ID");
    const role = requireRole(body.role);
    const state = body.state;
    if (state !== "ACTIVE" && state !== "SUSPENDED") throw new BadRequestException("Membership state is invalid");
    const expectedVersion = positiveInteger(body.expectedVersion, "Membership version");
    const whatsappNumbers = body.whatsappNumbers === undefined ? undefined
      : Array.isArray(body.whatsappNumbers) ? body.whatsappNumbers.map(value =>
        typeof value === "string" ? value.trim().replace(/[\s()-]/g, "") : "") : null;
    if (whatsappNumbers === null || whatsappNumbers?.some(value => !/^\+[1-9][0-9]{1,14}$/.test(value))) {
      throw new BadRequestException("Enter WhatsApp numbers in international format");
    }
    if (whatsappNumbers && new Set(whatsappNumbers).size !== whatsappNumbers.length) {
      throw new BadRequestException("WhatsApp numbers must not contain duplicates");
    }
    try {
      const result = await this.database.withTenant(request.principal.tenantId, async (client) => {
      const previous = await memberForUpdate(client, request.principal.tenantId, id);
      if (!previous) throw new NotFoundException("Team member not found");
      const numberOnlySelfUpdate = previous.user_id === request.principal.userId
        && role === previous.role && state === previous.state && body.whatsappNumbers !== undefined;
      assertCanManageMember(request.principal, previous, role, numberOnlySelfUpdate);
      if (Number(previous.version) !== expectedVersion) {
        throw new ConflictException("The membership changed; reload before saving");
      }
      const updated = (await client.query<MemberRow>(
        `UPDATE tenant_memberships
            SET role=$3,state=$4,version=version+1,updated_by=$5,updated_at=now(),
                whatsapp_numbers=CASE WHEN $6::boolean THEN $7::text[] ELSE whatsapp_numbers END
          WHERE tenant_id=$1 AND id=$2
          RETURNING id,user_id,role,state,version,whatsapp_numbers,created_at,updated_at,
            (SELECT email FROM users WHERE id=user_id) AS email,
            (SELECT display_name FROM users WHERE id=user_id) AS display_name`,
        [request.principal.tenantId, id, role, state, request.principal.userId, body.whatsappNumbers !== undefined, whatsappNumbers ?? []],
      )).rows[0]!;
      await appendAudit(client, request.principal, {
        action: "team.membership_updated",
        targetType: "tenant_membership",
        targetId: id,
        requestId: String(request.id),
        previousValue: { user_id: previous.user_id, role: previous.role, state: previous.state, version: Number(previous.version), whatsapp_numbers_registered: (previous.whatsapp_numbers ?? []).length },
        newValue: { user_id: updated.user_id, role: updated.role, state: updated.state, version: Number(updated.version), whatsapp_numbers_registered: updated.whatsapp_numbers.length, whatsapp_numbers_changed: JSON.stringify(previous.whatsapp_numbers ?? []) !== JSON.stringify(updated.whatsapp_numbers) },
      });
      return { ...updated, version: Number(updated.version), is_current_user: updated.user_id === request.principal.userId };
      });
      this.nativeMembership?.wake(request.principal.tenantId);
      return result;
    } catch (error) {
      if (lastOwnerError(error)) throw new ConflictException("Every workspace must retain at least one active owner");
      throw error;
    }
  }

  @Delete("team/members/:id")
  @Requires("team:write")
  async removeMember(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: { expectedVersion?: number },
  ) {
    assertUuid(id, "Membership ID");
    const expectedVersion = positiveInteger(body.expectedVersion, "Membership version");
    try {
      const result = await this.database.withTenant(request.principal.tenantId, async (client) => {
      const previous = await memberForUpdate(client, request.principal.tenantId, id);
      if (!previous) throw new NotFoundException("Team member not found");
      assertCanManageMember(request.principal, previous);
      if (Number(previous.version) !== expectedVersion) {
        throw new ConflictException("The membership changed; reload before removing it");
      }
      await client.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND id=$2", [request.principal.tenantId, id]);
      await appendAudit(client, request.principal, {
        action: "team.membership_removed",
        targetType: "tenant_membership",
        targetId: id,
        requestId: String(request.id),
        previousValue: { user_id: previous.user_id, email: previous.email, role: previous.role, state: previous.state },
        newValue: { state: "REMOVED" },
      });
      return { id, removed: true };
      });
      this.nativeMembership?.wake(request.principal.tenantId);
      return result;
    } catch (error) {
      if (lastOwnerError(error)) throw new ConflictException("Every workspace must retain at least one active owner");
      throw error;
    }
  }

  @Post("invitations/accept")
  @SetMetadata(PUBLIC_ROUTE, true)
  async acceptInvitation(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { token?: string; expectedSubject?: string },
  ) {
    if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedException("A valid identity token is required");
    const token = body.token?.trim();
    if (!token || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
      throw new BadRequestException("Invitation token is invalid");
    }
    const expectedSubject = body.expectedSubject;
    if (typeof expectedSubject !== "string" || expectedSubject !== expectedSubject.trim() || expectedSubject.length < 1 || expectedSubject.length > 320 || hasControlCharacters(expectedSubject)) {
      throw new BadRequestException("Identity subject is invalid");
    }
    const identity = await this.auth.authenticateInvitationIdentity(authorization.slice(7));
    if (identity.subject !== expectedSubject) throw new UnauthorizedException("The verified identity changed during invitation acceptance");
    try {
      const result = await this.database.acceptTenantInvitation({
        tokenHash: createHash("sha256").update(token).digest("hex"),
        oidcSubject: identity.subject,
        email: identity.email,
        displayName: identity.displayName,
      });
      if (!result) throw new GoneException("Invitation is invalid or expired");
      this.nativeMembership?.wake(result.tenant_id);
      return result;
    } catch (error) {
      const code = postgresCode(error);
      if (code === "P0002") throw new GoneException("Invitation is invalid or expired");
      if (code === "42501") throw new ForbiddenException("The signed-in identity does not match this invitation");
      if (code === "23505") throw new ConflictException("This identity already has a conflicting membership");
      throw error;
    }
  }
}

function validateWorkspace(body: WorkspaceInput) {
  const expectedVersion = positiveInteger(body.expectedVersion, "Workspace version");
  const name = cleanRequired(body.name, 2, 100, "Workspace name");
  const slug = cleanRequired(body.slug, 3, 48, "Workspace slug").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug) || slug.includes("--")) {
    throw new BadRequestException("Workspace slug must use lowercase letters, numbers, and single hyphens");
  }
  const accentColor = String(body.accentColor ?? "").toUpperCase();
  if (!/^#[0-9A-F]{6}$/u.test(accentColor)) throw new BadRequestException("Accent color must be a six-digit hex color");
  const defaultTheme = String(body.defaultTheme ?? "").toUpperCase();
  if (!THEMES.has(defaultTheme)) throw new BadRequestException("Default theme is invalid");
  if (typeof body.groupDisclosureEnabled !== "boolean") throw new BadRequestException("Group disclosure setting is required");
  const groupDisclosureMessage = cleanRequired(body.groupDisclosureMessage, 1, 500, "Group disclosure message", true);
  if (typeof body.ssoEnforcementRequested !== "boolean") throw new BadRequestException("SSO enforcement request setting is required");
  const ssoProviderName = cleanOptional(body.ssoProviderName, 100, "Identity provider name");
  const ssoIssuer = validateIssuer(body.ssoIssuer);
  const ssoEmailDomains = validateDomains(body.ssoEmailDomains);
  if (body.ssoEnforcementRequested && (!ssoProviderName || !ssoIssuer || !ssoEmailDomains.length)) {
    throw new BadRequestException("An SSO enforcement request requires a provider name, HTTPS issuer, and verified email domain");
  }
  const mfaRequiredRoles = validateMfaRoles(body.mfaRequiredRoles);
  if(body.supportAccessRequiresApproval!==true)throw new BadRequestException("Support access always requires workspace approval");
  return {
    expectedVersion,name,slug,accentColor,defaultTheme,
    groupDisclosureEnabled: body.groupDisclosureEnabled,groupDisclosureMessage,
    ssoEnforcementRequested: body.ssoEnforcementRequested,ssoProviderName,ssoIssuer,ssoEmailDomains,mfaRequiredRoles,
    sessionTimeoutMinutes: integerRange(body.sessionTimeoutMinutes, 15, 1440, "Session timeout"),
    privilegedReauthMinutes: integerRange(body.privilegedReauthMinutes, 5, 120, "Privileged reauthentication window"),
    supportAccessRequiresApproval: true,
  };
}

function validateInvite(body: { email?: string; displayName?: string; role?: string; expiresInDays?: number }) {
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320 || hasControlCharacters(email)) {
    throw new BadRequestException("A valid invitation email is required");
  }
  return {
    email,
    displayName: cleanOptional(body.displayName, 120, "Display name"),
    role: requireRole(body.role),
    expiresInDays: integerRange(body.expiresInDays ?? 7, 1, 30, "Invitation expiry"),
  };
}

function invitationResponse(row: InvitationRow, duplicate: boolean) {
  return {
    id: row.id,email: row.email,display_name: row.display_name,role: row.role,
    state: row.state,expires_at: row.expires_at,version: Number(row.version),
    delivery_state: row.delivery_state ?? null,
    delivery_error_code: publicInvitationDeliveryCode(row.delivery_error_code),duplicate,
  };
}

function publicInvitationDeliveryCode(code: string | null | undefined) {
  if (!code) return null;
  return ["EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN", "EMAIL_PROVIDER_RECEIPT_PERSISTENCE_UNKNOWN"].includes(code)
    ? "INVITATION_DELIVERY_OUTCOME_UNKNOWN"
    : "INVITATION_DELIVERY_FAILED";
}

async function lockActiveInvitationDeliveries(client: PoolClient, tenantId: string, invitationId: string) {
  return (await client.query<{ state: string }>(
    `SELECT state
       FROM tenant_invitation_email_outbox
      WHERE tenant_id=$1 AND invitation_id=$2
        AND state IN ('PENDING','SENDING','FAILED_RETRYABLE')
      ORDER BY created_at,id
      FOR UPDATE`,
    [tenantId, invitationId],
  )).rows;
}

async function memberForUpdate(client: PoolClient, tenantId: string, id: string) {
  return (await client.query<MemberRow>(
    `SELECT m.id,m.user_id,u.email,u.display_name,m.role,m.state,m.version,m.whatsapp_numbers,m.created_at,m.updated_at
       FROM tenant_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.id=$2 FOR UPDATE OF m`,
    [tenantId, id],
  )).rows[0] ?? null;
}

function assertCanManageMember(
  principal: AuthenticatedRequest["principal"],
  target: MemberRow,
  nextRole?: TenantRole,
  numberOnlySelfUpdate = false,
) {
  if (target.user_id === principal.userId && !numberOnlySelfUpdate) {
    throw new ForbiddenException("You cannot change or remove your own workspace access");
  }
  if (principal.role === "tenant_admin" && (target.role === "tenant_owner" || nextRole === "tenant_owner")) {
    throw new ForbiddenException("Tenant administrators cannot change owner access");
  }
  if (principal.role !== "tenant_owner" && principal.role !== "tenant_admin") {
    throw new ForbiddenException("Your role cannot manage workspace access");
  }
}

function lastOwnerError(error: unknown) {
  return error instanceof Error && error.message.includes("WASALX_LAST_ACTIVE_OWNER");
}

function assertCanAssignRole(actorRole: TenantRole, role: TenantRole) {
  if (actorRole === "tenant_admin" && role === "tenant_owner") {
    throw new ForbiddenException("Tenant administrators cannot invite owners");
  }
  if (actorRole !== "tenant_owner" && actorRole !== "tenant_admin") {
    throw new ForbiddenException("Your role cannot invite workspace members");
  }
}

function assertCanManageInvitation(actorRole: TenantRole, invitationRole: TenantRole) {
  if (actorRole === "tenant_admin" && invitationRole === "tenant_owner") {
    throw new ForbiddenException("Tenant administrators cannot manage owner invitations");
  }
  if (actorRole !== "tenant_owner" && actorRole !== "tenant_admin") {
    throw new ForbiddenException("Your role cannot manage invitations");
  }
}

async function lockIdempotency(client: PoolClient, tenantId: string, key: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${tenantId}:${key}`]);
}

function requireIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key || key.length > 255 || hasControlCharacters(key)) throw new BadRequestException("A valid Idempotency-Key header is required");
  return key;
}

function requireRole(value: string | undefined) {
  if (!value || !ROLES.has(value as TenantRole)) throw new BadRequestException("Workspace role is invalid");
  return value as TenantRole;
}

function validateMfaRoles(value: string[] | undefined) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new BadRequestException("At least one MFA-required role is required");
  }
  const roles = [...new Set(value.map((role) => requireRole(role)))];
  if (!roles.includes("tenant_owner")) throw new BadRequestException("MFA must remain required for tenant owners");
  return roles;
}

function validateDomains(value: string[] | undefined) {
  if (!Array.isArray(value) || value.length > 20) throw new BadRequestException("SSO email domains are invalid");
  return [...new Set(value.map((domain) => {
    const normalized = String(domain).trim().toLowerCase();
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(normalized)) {
      throw new BadRequestException(`Invalid SSO email domain: ${normalized || "empty value"}`);
    }
    return normalized;
  }))];
}

function validateIssuer(value: string | null | undefined) {
  const normalized = cleanOptional(value, 500, "SSO issuer");
  if (!normalized) return null;
  let url: URL;
  try { url = new URL(normalized); } catch { throw new BadRequestException("SSO issuer must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new BadRequestException("SSO issuer must be an HTTPS URL without credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/u, "");
}

function cleanRequired(value: unknown, minimum: number, maximum: number, label: string, allowNewline = false) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < minimum || normalized.length > maximum || hasControlCharacters(normalized, allowNewline)) {
    throw new BadRequestException(`${label} must be between ${minimum} and ${maximum} characters`);
  }
  return normalized;
}

function cleanOptional(value: unknown, maximum: number, label: string) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return cleanRequired(value, 1, maximum, label);
}

function positiveInteger(value: unknown, label: string) { return integerRange(value, 1, Number.MAX_SAFE_INTEGER, label); }
function integerRange(value: unknown, minimum: number, maximum: number, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new BadRequestException(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}
function assertUuid(value: string, label: string) { if (!UUID.test(value)) throw new BadRequestException(`${label} is invalid`); }
function canonicalHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function postgresCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String(error.code) : null; }
function hasControlCharacters(value: string, allowNewline = false) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    if (allowNewline && (code === 9 || code === 10 || code === 13)) return false;
    return code < 32 || code === 127;
  });
}
