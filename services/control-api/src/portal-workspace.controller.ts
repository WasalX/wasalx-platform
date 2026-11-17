import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Header, NotFoundException, Post, Req, ServiceUnavailableException, StreamableFile } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { MediaUploadAdmission, WORKSPACE_INLINE_MEDIA_TYPES } from "@wasalx/core/media";
import { readWorkspaceUpload, validateWorkspaceUpload, WORKSPACE_UPLOAD_TYPE } from "./workspace-binary.js";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import { can } from "./rbac.js";
import type { AuthenticatedRequest, Principal } from "./types.js";
import { ZammadServiceSecretService } from "./zammad-service-secret.service.js";

const UPLOAD_PURPOSE = "wasalx.portal-workspace-upload.v1";
const UPLOAD_PATH = "/api/v1/wasalx/portal-workspace/upload";
const uploadAdmission = new MediaUploadAdmission(2, 1);
const BINARY = new Set(["ATTACHMENT", "GROUP_MEDIA"]);
const PURPOSE = "wasalx.portal-workspace.v1";
const PATH = "/api/v1/wasalx/portal-workspace";
const IDENTITY_PURPOSE = "wasalx.service-identity.v1";
const IDENTITY_PATH = "/api/v1/wasalx/service/identity";
const READS = new Set(["PRIVACY_TARGET", "CHECK", "LIST", "SHOW", "ARTICLES", "ATTACHMENT", "GROUP_MEDIA", "RECEIPT", "CREATE_OPTIONS", "CREATE_RECEIPT", "ARTICLE_CONTENT", "SOURCE_CONTEXT", "PREVIEW", "GROUP_CHECK", "GROUP_LIST", "GROUP_SHOW",
  "GROUP_MESSAGES", "GROUP_CONTEXT", "GROUP_PARTICIPANTS", "GROUP_TICKETS", "GROUP_TEAMS", "GROUP_RECEIPT", "GROUP_TICKET_RECEIPT",
  "IDENTITY_STATUS", "IDENTITY_RECEIPT", "TEAM_LIST", "TEAM_SHOW", "TEAM_RECEIPT", "MAILBOX_LIST", "MAILBOX_SHOW", "MAILBOX_VERIFY_STATUS", "MAILBOX_SIGNATURE_SHOW", "MAILBOX_RECEIPT"]);
const WRITES = new Set(["IDENTITY_INITIALIZE", "IDENTITY_PREPARE", "IDENTITY_GRANT", "IDENTITY_BIND", "IDENTITY_COMPLETE", "REPLY", "UPDATE", "CREATE_TICKET", "REMOVE_UPLOAD", "GROUP_REMOVE_UPLOAD", "GROUP_READ", "GROUP_SEND", "GROUP_REACTION", "GROUP_CREATE_TICKET",
  "GROUP_LINK_TICKET", "GROUP_REPAIR_TICKET_LINK", "TEAM_CREATE", "TEAM_SAVE", "TEAM_GRANT_SAVE",
  "MAILBOX_CREATE", "MAILBOX_SAVE", "MAILBOX_VERIFY_START", "MAILBOX_VERIFY_RECHECK", "MAILBOX_ACTIVATE", "MAILBOX_PAUSE", "MAILBOX_SIGNATURE_SAVE"]);
function writesWorkspace(body: WorkspaceRequest) {
  return body.operation === "IDENTITY_RECEIPT" && body.input.action === "CANCEL_IF_UNADMITTED" || WRITES.has(body.operation) || ["RECEIPT", "CREATE_RECEIPT", "GROUP_RECEIPT", "GROUP_TICKET_RECEIPT"].includes(body.operation) && body.input.action !== "LOOKUP"
    || ["TEAM_RECEIPT", "MAILBOX_RECEIPT"].includes(body.operation) && body.input.cancel_if_missing === true;
}
type WorkspaceRequest = { operation: string; input: Record<string, unknown> };
type SetupActor = Omit<Actor, "native_user_id"> & { native_user_id: string | null };
type Actor = { instance_id: string; base_url: string; service_secret_reference: string; privacy_secret_reference: string; native_user_id: string; revision: string | number };

export function validateWorkspaceRequest(value: unknown): WorkspaceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Invalid workspace request");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "input,operation" || typeof body.operation !== "string" ||
    !READS.has(body.operation) && !WRITES.has(body.operation) || !body.input || typeof body.input !== "object" || Array.isArray(body.input))
    throw new BadRequestException("Invalid workspace request");
  if (Buffer.byteLength(JSON.stringify(body)) > 32_768) throw new BadRequestException("Workspace request is too large");
  return body as WorkspaceRequest;
}

@Controller("v1/inbox")
export class PortalWorkspaceController {
  constructor(private readonly database: DatabaseService, private readonly secrets: ZammadServiceSecretService) {}

  @Post()
  @Header("Cache-Control", "private, no-store")
  @Header("X-Content-Type-Options", "nosniff")
  @Requires("ticket:read")
  async execute(@Req() request: AuthenticatedRequest, @Body() value: unknown) {
    const body = validateWorkspaceRequest(value);
    if (body.operation === "PRIVACY_TARGET") throw new ForbiddenException("Use privacy target selection");
    return this.run(request, body);
  }

  async privacyTarget(request: AuthenticatedRequest, input: Record<string, unknown>) {
    if (!can(request.principal.role, "ticket:read")) throw new ForbiddenException("Target is unavailable");
    return this.run(request, { operation: "PRIVACY_TARGET", input });
  }

  private async run(request: AuthenticatedRequest, body: WorkspaceRequest) {
    if (writesWorkspace(body) && !can(request.principal.role, "ticket:write")) throw new ForbiddenException("Workspace access is unavailable");
    if (body.operation.startsWith("TEAM_")) {
      if (!can(request.principal.role, writesWorkspace(body) ? "team:write" : "team:read")) throw new ForbiddenException("Team administration is unavailable");
      if (writesWorkspace(body)) await this.database.withTenant(request.principal.tenantId,
        client => requirePrivilegedAuthentication(client, request.principal, "changing support teams"));
    }
    if (body.operation.startsWith("MAILBOX_")) {
      if (!can(request.principal.role, writesWorkspace(body) ? "settings:write" : "settings:read")) throw new ForbiddenException("Customer email administration is unavailable");
      if (writesWorkspace(body)) await this.database.withTenant(request.principal.tenantId,
        client => requirePrivilegedAuthentication(client, request.principal, "changing customer email"));
    }
    const identity = body.operation.startsWith("IDENTITY_");
    if (identity) {
      if (request.principal.role !== "tenant_owner") throw new ForbiddenException("Only a workspace owner can manage service access");
      if (writesWorkspace(body)) await this.database.withTenant(request.principal.tenantId,
        client => requirePrivilegedAuthentication(client, request.principal, "changing service access"));
      if (Object.keys(body.input).some(key => key.startsWith("configured_"))) throw new BadRequestException("Invalid workspace request");
    }
    const actor = identity ? await this.identityActor(request.principal) : await this.actor(request.principal);
    const purpose = identity ? IDENTITY_PURPOSE : PURPOSE;
    const path = identity ? IDENTITY_PATH : PATH;
    const credentials = await this.secrets.resolveCredentials(actor.service_secret_reference,
      { tenantId: request.principal.tenantId, instanceId: actor.instance_id });
    const input = identity ? { ...body.input,
      configured_runtime_sha256: createHash("sha256").update(credentials.apiToken).digest("hex"),
      configured_privacy_sha256: createHash("sha256").update(await this.secrets.resolvePrivacyToken(actor.privacy_secret_reference,
        { tenantId: request.principal.tenantId, instanceId: actor.instance_id })).digest("hex") } : body.input;
    const source = { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE };
    if (!source.issuer || !source.audience) throw new ServiceUnavailableException("Workspace identity is unavailable");
    const envelope = JSON.stringify({
      purpose, tenant_id: request.principal.tenantId, instance_id: actor.instance_id, source,
      actor: { user_id: request.principal.userId, subject: request.principal.subject,
        revision: Number(actor.revision), native_user_id: actor.native_user_id, ...(identity ? { email: request.principal.email } : {}) },
      assurance: { auth_time: request.principal.authenticatedAt, amr: request.principal.authenticationMethods ?? [],
        acr: request.principal.authenticationContext ?? null },
      operation: body.operation, input,
    });
    const target = new URL(path, actor.base_url);
    // The provisioned tenant instance owns its private service origin, including Compose HTTP.
    if (target.username || target.password || target.hash || !["http:", "https:"].includes(target.protocol))
      throw new ServiceUnavailableException("Workspace service is unavailable");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", credentials.jwtSecret).update(`${purpose}\nPOST\n${path}\n${timestamp}\n${envelope}`).digest("hex");
    let response: Response;
    let result: unknown;
    try {
      response = await fetch(target, { method: "POST", body: envelope, redirect: "error", signal: AbortSignal.timeout(BINARY.has(body.operation) ? 60_000 : 12_000),
        headers: { authorization: `Token token=${credentials.apiToken}`, "content-type": "application/json",
          "x-wasalx-timestamp": timestamp, "x-wasalx-signature": signature } });
      result = BINARY.has(body.operation) && response.ok ? null : await boundedResult(response);
    } catch {
      // Never retry a mutation: the native receipt is the authority after an unknown result.
      throw new ServiceUnavailableException({ code: "WORKSPACE_OUTCOME_UNKNOWN", message: "Workspace result is unavailable. Check the operation before trying again." });
    }
    if (!response.ok) {
      const failure = result as { code?: string; group_id?: string; operation_id?: string; state?: string; effect?: string; terminal?: boolean } | null;
      const groupDenied = response.status === 403 && body.operation.startsWith("GROUP_") &&
        failure?.code === "GROUP_ACCESS_DENIED" && failure.group_id === body.input.group_id;
      const rejected = [400, 404].includes(response.status) && body.operation.startsWith("GROUP_") &&
        failure?.code === "GROUP_OPERATION_REJECTED" && failure.group_id === body.input.group_id &&
        failure.operation_id === body.input.request_token && failure.state === "NOT_APPLIED" && failure.effect === "NONE" && failure.terminal === true;
      const reauthentication = response.status === 403 && failure?.code === "REAUTHENTICATION_REQUIRED" &&
        writesWorkspace(body) && (body.operation.startsWith("TEAM_") || body.operation.startsWith("MAILBOX_") || identity);
      if (reauthentication || groupDenied || rejected) {
        const current = identity ? await this.identityActor(request.principal) : await this.actor(request.principal);
        if (current.instance_id !== actor.instance_id || current.native_user_id !== actor.native_user_id || String(current.revision) !== String(actor.revision))
          throw new ForbiddenException("Workspace access changed");
        if (reauthentication) throw new ForbiddenException({ code: "REAUTHENTICATION_REQUIRED", message: "Sign in again before changing workspace settings." });
        if (groupDenied) throw new ForbiddenException({ code: "GROUP_ACCESS_DENIED", group_id: body.input.group_id, message: "Group access is unavailable" });
        const proof = { code: "GROUP_OPERATION_REJECTED", effect: "NONE", terminal: true, message: "The group action was not submitted" };
        if (response.status === 404) throw new NotFoundException(proof);
        throw new BadRequestException(proof);
      }
      if (response.status === 403 || response.status === 401) throw new ForbiddenException("Workspace access is unavailable");
      if (response.status === 404) throw new NotFoundException("Conversation is unavailable");
      if (response.status === 409) throw new ConflictException("Conversation changed. Reload before continuing.");
      if (response.status === 400 || response.status === 422) throw new BadRequestException("This conversation action is unavailable. Check the conversation settings.");
      throw new ServiceUnavailableException("Workspace service is unavailable");
    }
    let expectedNativeId = actor.native_user_id;
    if (identity) {
      try {
        expectedNativeId = await this.settleOwnerProjection(request, actor, result, body);
        if (result && typeof result === "object") { const publicResult = { ...result as Record<string,unknown> }; delete publicResult.owner_projection; result = publicResult; }
      } catch (error) {
        const failure = error instanceof ForbiddenException ? error.getResponse() : undefined;
        if (failure && typeof failure === "object" && "code" in failure && failure.code === "REAUTHENTICATION_REQUIRED") {
          let unchanged = false;
          try {
            const current = await this.identityActor(request.principal);
            unchanged = current.instance_id === actor.instance_id && current.native_user_id === actor.native_user_id && String(current.revision) === String(actor.revision);
          } catch { /* A stale owner must not receive a recovery authority hint. */ }
          if (unchanged) throw new ForbiddenException({ code: "REAUTHENTICATION_REQUIRED", message: "Sign in again before changing workspace settings." });
        }
        throw new ServiceUnavailableException({ code: "WORKSPACE_OUTCOME_UNKNOWN", message: "Check the setup operation before trying again." });
      }
    }
    let current: SetupActor;
    try { current = identity ? await this.identityActor(request.principal) : await this.actor(request.principal); }
    catch (error) {
      if (writesWorkspace(body)) throw new ServiceUnavailableException({ code: "WORKSPACE_OUTCOME_UNKNOWN", message: "Check the operation before trying again." });
      throw error;
    }
    if (current.instance_id !== actor.instance_id || current.native_user_id !== expectedNativeId || String(current.revision) !== String(actor.revision))
      if (writesWorkspace(body)) throw new ServiceUnavailableException({ code: "WORKSPACE_OUTCOME_UNKNOWN", message: "Check the operation before trying again." });
      else throw new ForbiddenException("Workspace access changed");
    if (identity && writesWorkspace(body)) await this.database.withTenant(request.principal.tenantId, client =>
      appendAudit(client, request.principal, { action: "team.service_access_changed", targetType: "zammad_instance", targetId: actor.instance_id,
        requestId: String(request.id), newValue: { operation: body.operation, request_id: body.input.request_id, state: (result as { state?: string }).state } }));
    if (BINARY.has(body.operation)) {
      const length = Number(response.headers.get("content-length"));
      if (!response.body || response.headers.get("content-length") === null || !Number.isSafeInteger(length) || length < 0 || length > 50_000_000)
        throw new ServiceUnavailableException("Attachment is unavailable");
      const nativeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const inline = body.operation === "GROUP_MEDIA" && WORKSPACE_INLINE_MEDIA_TYPES.has(nativeType);
      const reader = response.body.getReader();
      return new StreamableFile(Readable.from((async function* () {
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > length) throw new Error("Attachment size changed");
            yield value;
          }
          if (total !== length) throw new Error("Attachment is incomplete");
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      })()), { type: inline ? nativeType : "application/octet-stream", disposition: inline ? "inline" : "attachment", length });
    }
    return result;
  }

  @Post("upload")
  @Header("Cache-Control", "private, no-store")
  @Requires("ticket:write")
  async upload(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const release = uploadAdmission.tryAcquire(request.principal.tenantId);
    if (!release) throw new ServiceUnavailableException("Another upload is in progress");
    try {
      const metadata = request.headers['x-wasalx-upload-metadata'];
      if (typeof metadata !== "string" || !/^[A-Za-z0-9_-]{1,8000}$/u.test(metadata) ||
          request.headers['content-type'] !== WORKSPACE_UPLOAD_TYPE) throw new BadRequestException("Invalid upload");
      let value: unknown;
      try {
        const decoded = Buffer.from(metadata, "base64url");
        if (decoded.toString("base64url") !== metadata || decoded.length > 6_000) throw new Error();
        value = JSON.parse(decoded.toString("utf8"));
      } catch { throw new BadRequestException("Invalid upload metadata"); }
      const upload = validateWorkspaceUpload(value);
      if (request.headers['content-length'] !== String(upload.file.byte_size)) throw new BadRequestException("Invalid upload size");
      const actor = await this.actor(request.principal);
      const bytes = await readWorkspaceUpload(body, upload.file.byte_size);
      if (createHash("sha256").update(bytes).digest("hex") !== upload.file.sha256) throw new BadRequestException("Upload content changed");
      const source = { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE };
      if (!source.issuer || !source.audience) throw new ServiceUnavailableException("Workspace identity is unavailable");
      const envelope = JSON.stringify({ purpose: UPLOAD_PURPOSE, tenant_id: request.principal.tenantId,
        instance_id: actor.instance_id, source,
        actor: { user_id: request.principal.userId, subject: request.principal.subject,
          revision: Number(actor.revision), native_user_id: actor.native_user_id },
        assurance: { auth_time: request.principal.authenticatedAt, amr: request.principal.authenticationMethods ?? [],
          acr: request.principal.authenticationContext ?? null }, ...upload });
      if (Buffer.byteLength(envelope) > 6_000) throw new BadRequestException("Invalid upload metadata");
      const credentials = await this.secrets.resolveCredentials(actor.service_secret_reference,
        { tenantId: request.principal.tenantId, instanceId: actor.instance_id });
      const target = new URL(UPLOAD_PATH, actor.base_url);
      if (target.username || target.password || target.hash || !["http:", "https:"].includes(target.protocol))
        throw new ServiceUnavailableException("Workspace service is unavailable");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", credentials.jwtSecret).update(`${UPLOAD_PURPOSE}\nPOST\n${UPLOAD_PATH}\n${timestamp}\n${envelope}`).digest("hex");
      let response: Response, result: unknown;
      try {
        response = await fetch(target, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
          headers: { authorization: `Token token=${credentials.apiToken}`, "content-type": "application/octet-stream",
            "content-length": String(bytes.length), "x-wasalx-upload-envelope": Buffer.from(envelope).toString("base64url"),
            "x-wasalx-timestamp": timestamp, "x-wasalx-signature": signature }, body: Uint8Array.from(bytes).buffer });
        result = await boundedResult(response);
      } catch { throw new ServiceUnavailableException("Upload result is unavailable. Try this file again."); }
      const failure = result as {code?: string; group_id?: string} | null;
      if (response.status === 403 && upload.operation === "GROUP_UPLOAD" && failure?.code === "GROUP_ACCESS_DENIED" && failure.group_id === upload.input.group_id) {
        const current = await this.actor(request.principal);
        if (current.instance_id !== actor.instance_id || current.native_user_id !== actor.native_user_id || String(current.revision) !== String(actor.revision))
          throw new ForbiddenException("Workspace access changed");
        throw new ForbiddenException({code:"GROUP_ACCESS_DENIED",group_id:upload.input.group_id,message:"Group access is unavailable"});
      }
      if (response.status === 401 || response.status === 403) throw new ForbiddenException("Workspace access is unavailable");
      if (response.status === 404) throw new NotFoundException("Upload destination is unavailable");
      if (response.status === 400 || response.status === 422) throw new BadRequestException("This file is unavailable for this conversation");
      if (!response.ok) throw new ServiceUnavailableException("Upload service is unavailable");
      const current = await this.actor(request.principal);
      if (current.instance_id !== actor.instance_id || current.native_user_id !== actor.native_user_id || String(current.revision) !== String(actor.revision))
        throw new ForbiddenException("Workspace access changed");
      return result;
    } finally { release(); }
  }

  private async identityActor(principal: Principal): Promise<SetupActor> {
    try { return await this.actor(principal); }
    catch (error) { if (!(error instanceof ForbiddenException)) throw error; }
    if (principal.role !== "tenant_owner") throw new ForbiddenException("Workspace setup is unavailable");
    const row = (await this.database.rows<SetupActor>(principal.tenantId, `SELECT z.id AS instance_id,z.base_url,z.service_secret_reference,z.privacy_secret_reference,
      p.native_user_id,p.revision FROM native_membership_projections p
      JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id JOIN users u ON u.id=p.user_id
      JOIN tenants t ON t.id=p.tenant_id JOIN tenant_settings s ON s.tenant_id=p.tenant_id
      JOIN zammad_instances z ON z.tenant_id=p.tenant_id AND z.id=p.zammad_instance_id
      WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.oidc_subject=$3 AND u.oidc_subject=p.oidc_subject AND p.email=u.email AND u.email=$4
        AND p.role='tenant_owner' AND m.role=p.role AND m.state='ACTIVE' AND p.member_state='ACTIVE'
        AND t.state='ACTIVE' AND z.state='WORKING' AND s.native_membership_sync_enabled
        AND p.sync_state='PROTECTED' AND p.native_user_id IS NULL AND p.applied_revision=0 AND p.requested_native_user_id IS NULL`,
      [principal.tenantId,principal.userId,principal.subject,principal.email]))[0];
    if (!row || row.native_user_id !== null || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision)<1)
      throw new ForbiddenException("Review workspace account synchronization before service setup");
    return row;
  }

  private async settleOwnerProjection(request:AuthenticatedRequest, captured:SetupActor, result:unknown, body:WorkspaceRequest) {
    const appliedInitialization = captured.native_user_id === null && (body.operation === "IDENTITY_INITIALIZE" || body.operation === "IDENTITY_RECEIPT" && body.input.kind === "IDENTITY_INITIALIZE")
      && !!result && typeof result === "object" && (result as {state?:unknown}).state === "APPLIED";
    if (appliedInitialization && !(result as {owner_projection?:unknown}).owner_projection) throw new Error("Missing setup proof");
    if (!result || typeof result !== "object" || !("owner_projection" in result) || !(result as {owner_projection?:unknown}).owner_projection) return captured.native_user_id;
    const proof = (result as {owner_projection:Record<string,unknown>}).owner_projection, principal=request.principal;
    if (!proof || typeof proof!=="object" || proof.portal_user_id!==principal.userId || typeof proof.native_user_id!=="string"
      || !/^[1-9][0-9]{0,15}$/u.test(proof.native_user_id) || !Number.isSafeInteger(proof.revision) || Number(proof.revision)<1
      || proof.subject_sha256!==createHash("sha256").update(principal.subject).digest("hex")
      || proof.email_sha256!==createHash("sha256").update(principal.email).digest("hex")
      || typeof proof.identity_receipt_sha256!=="string" || !/^[a-f0-9]{64}$/u.test(proof.identity_receipt_sha256)) throw new Error("Invalid setup proof");
    if (captured.native_user_id === proof.native_user_id && Number(captured.revision)>=Number(proof.revision)) return captured.native_user_id;
    return this.database.withTenant(principal.tenantId,async client=>{
      const current = (await client.query<{current_role:typeof principal.role|null}>(
        "SELECT app.lock_current_operator_principal($1,$2,$3,$4) AS current_role",
        [principal.userId,principal.subject,principal.email,principal.role])).rows[0];
      if (!current || current.current_role!==principal.role || current.current_role!=="tenant_owner") throw new Error("Workspace ownership changed");
      const instance = (await client.query<{working:boolean}>(
        "SELECT app.lock_current_working_zammad_instance($1) AS working",[captured.instance_id])).rows[0];
      if (!instance?.working) throw new Error("Workspace instance changed");
      const row = (await client.query<{native_user_id:string|null;revision:string|number;applied_revision:string|number;sync_state:string}>(`SELECT p.native_user_id,p.revision,p.applied_revision,p.sync_state
        FROM native_membership_projections p JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
        JOIN users u ON u.id=p.user_id JOIN tenants t ON t.id=p.tenant_id JOIN tenant_settings s ON s.tenant_id=p.tenant_id
        JOIN zammad_instances z ON z.tenant_id=p.tenant_id AND z.id=p.zammad_instance_id
        WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.oidc_subject=$3 AND u.oidc_subject=p.oidc_subject AND p.email=u.email AND u.email=$4
          AND p.role='tenant_owner' AND m.role=p.role AND p.member_state='ACTIVE' AND m.state='ACTIVE'
          AND t.state='ACTIVE' AND z.state='WORKING' AND z.id=$5 AND s.native_membership_sync_enabled AND p.requested_native_user_id IS NULL
        FOR UPDATE OF p NOWAIT`,[principal.tenantId,principal.userId,principal.subject,principal.email,captured.instance_id])).rows[0];
      if (!row) throw new Error("Workspace ownership changed");
      await requirePrivilegedAuthentication(client,principal,"confirming service setup");
      if (row.sync_state==='READY' && row.native_user_id===proof.native_user_id && Number(row.revision)===Number(row.applied_revision)
        && Number(row.revision)>=Number(proof.revision)) return proof.native_user_id as string;
      if (row.sync_state!=='PROTECTED' || row.native_user_id!==null || Number(row.applied_revision)!==0
        || Number(row.revision)!==Number(captured.revision) || Number(row.revision)!==Number(proof.revision)) throw new Error("Setup projection changed");
      const update = await client.query(`UPDATE native_membership_projections SET native_user_id=$3,applied_revision=revision,sync_state='READY',updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND revision=$4 AND native_user_id IS NULL AND applied_revision=0 AND sync_state='PROTECTED' AND requested_native_user_id IS NULL`,
        [principal.tenantId,principal.userId,proof.native_user_id,proof.revision]);
      if (update.rowCount!==1) throw new Error("Setup confirmation changed");
      await appendAudit(client,principal,{action:"team.service_access_initialized",targetType:"zammad_instance",targetId:captured.instance_id,
        requestId:String(request.id),newValue:{revision:proof.revision,receipt_sha256:proof.identity_receipt_sha256}});
      return proof.native_user_id as string;
    });
  }

  private async actor(principal: Principal): Promise<Actor> {
    const row = (await this.database.rows<Actor>(principal.tenantId, `SELECT z.id AS instance_id,z.base_url,z.service_secret_reference,z.privacy_secret_reference,
      p.native_user_id,p.revision FROM native_membership_projections p
      JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
      JOIN users u ON u.id=p.user_id JOIN tenants t ON t.id=p.tenant_id
      JOIN tenant_settings s ON s.tenant_id=p.tenant_id
      JOIN zammad_instances z ON z.tenant_id=p.tenant_id AND z.id=p.zammad_instance_id
      WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.oidc_subject=$3 AND u.oidc_subject=p.oidc_subject
        AND p.email=u.email AND p.member_state='ACTIVE' AND p.role=$4 AND m.role=p.role AND m.state='ACTIVE'
        AND p.role<>'auditor' AND p.sync_state='READY' AND p.revision=p.applied_revision
        AND t.state='ACTIVE' AND z.state='WORKING' AND s.native_membership_sync_enabled`,
    [principal.tenantId, principal.userId, principal.subject, principal.role]))[0];
    if (!row || !/^[1-9][0-9]{0,15}$/u.test(row.native_user_id) || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1)
      throw new ForbiddenException("Workspace account access is unavailable");
    return row;
  }
}

async function boundedResult(response: Response) {
  if (!(response.headers.get("content-type") ?? "").startsWith("application/json") || !response.body) throw new Error("Invalid workspace response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5_242_880) throw new Error("Workspace response limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
