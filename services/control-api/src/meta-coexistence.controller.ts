import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { MetaCoexistenceConsentRequest, MetaCoexistenceContactView, MetaCoexistenceMessageView, MetaCoexistencePage, MetaCoexistenceSummary } from "@wasalx/core/meta-coexistence-contract";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import type { AuthenticatedRequest } from "./types.js";

@Controller("v1/connections/:connectionId/meta/coexistence")
export class MetaCoexistenceController {
  constructor(private readonly database: DatabaseService) {}

  @Get() @Requires("connection:read") @Header("Cache-Control", "no-store")
  summary(@Req() request: AuthenticatedRequest, @Param("connectionId") id: string): Promise<MetaCoexistenceSummary> {
    return this.read(request, id, async (client, contextId) => {
      const row = (await client.query<MetaCoexistenceSummary>(`SELECT revision,
        jsonb_build_object('history',consent_history,'contacts',consent_contacts,'echoes',consent_echoes) AS consent,
        contacts_request->>'state' AS "contactsRequest",history_request->>'state' AS "historyRequest",
        history_observation AS "historyObservation",CASE WHEN last_onboarded_time IS NULL THEN 'UNKNOWN' ELSE 'TIMESTAMP_OBSERVED' END AS "windowEvidence",
        provider_progress AS "providerProgress",processed_chunks AS "processedChunks",last_activity_at::text AS "lastActivityAt",
        CASE WHEN EXISTS(SELECT 1 FROM meta_coexistence_messages imported JOIN normalized_messages live
          ON live.tenant_id=imported.tenant_id AND live.connection_id=imported.connection_id AND live.external_message_id=imported.external_message_id
          WHERE imported.tenant_id=context.tenant_id AND imported.context_id=context.id AND ${CONFLICTING_LIVE}) THEN 'REVIEW_REQUIRED' ELSE hold_reason END AS "holdReason",
        (SELECT count(*)::integer FROM meta_coexistence_messages m WHERE m.tenant_id=context.tenant_id AND m.context_id=context.id
          AND NOT app.meta_coexistence_subject_blocked(context.id,m.subject_phone,m.source,m.provider_timestamp)) AS "messageCount",
        (SELECT count(*)::integer FROM meta_coexistence_contacts c WHERE c.tenant_id=context.tenant_id AND c.context_id=context.id AND c.subject_phone IS NOT NULL
          AND c.action='add' AND NOT app.meta_coexistence_subject_blocked(context.id,c.subject_phone,'CONTACTS',c.provider_timestamp)) AS "contactCount"
        FROM meta_coexistence_contexts context WHERE tenant_id=$1 AND id=$2`, [request.principal.tenantId, contextId])).rows[0];
      if (!row) throw new NotFoundException(); return row;
    });
  }

  @Get("contacts") @Requires("connection:read") @Header("Cache-Control", "no-store")
  contacts(@Req() request: AuthenticatedRequest, @Param("connectionId") id: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string): Promise<MetaCoexistencePage<MetaCoexistenceContactView>> {
    const paging = page(cursor, limit);
    return this.read(request, id, async (client, contextId) => {
      const rows = (await client.query<MetaCoexistenceContactView>(`WITH candidates AS (
        SELECT subject_digest,subject_phone,display_name,provider_timestamp,action='remove' AS removed,1 AS priority
          FROM meta_coexistence_contacts WHERE tenant_id=$1 AND context_id=$2 AND subject_phone IS NOT NULL
            AND NOT app.meta_coexistence_subject_blocked($2,subject_phone,'CONTACTS',provider_timestamp)
        UNION ALL SELECT subject_digest,subject_phone,NULL,provider_timestamp,false,2 FROM meta_coexistence_messages
          WHERE tenant_id=$1 AND context_id=$2 AND NOT app.meta_coexistence_subject_blocked($2,subject_phone,source,provider_timestamp)
      ), threads AS (SELECT DISTINCT ON(subject_digest) * FROM candidates ORDER BY subject_digest,priority,provider_timestamp DESC)
      SELECT subject_digest AS "threadId",subject_phone AS phone,display_name AS name,provider_timestamp::text AS "lastChangedAt",removed
        FROM threads WHERE subject_digest>$3 ORDER BY subject_digest LIMIT $4`, [request.principal.tenantId, contextId, paging.key, paging.limit + 1])).rows;
      return result(rows, paging.limit, row => row.threadId);
    });
  }

  @Get("threads/:threadId/messages") @Requires("connection:read") @Header("Cache-Control", "no-store")
  messages(@Req() request: AuthenticatedRequest, @Param("connectionId") id: string, @Param("threadId") threadId: string,
    @Query("cursor") cursor?: string, @Query("limit") limit?: string): Promise<MetaCoexistencePage<MetaCoexistenceMessageView>> {
    if (!/^[0-9a-f]{64}$/u.test(threadId)) throw new BadRequestException("Invalid conversation");
    const paging = page(cursor, limit);
    return this.read(request, id, async (client, contextId) => {
      const conflict = await client.query(`SELECT 1 FROM meta_coexistence_messages imported JOIN normalized_messages live
        ON live.tenant_id=imported.tenant_id AND live.connection_id=imported.connection_id AND live.external_message_id=imported.external_message_id
        WHERE imported.tenant_id=$1 AND imported.context_id=$2 AND imported.subject_digest=$3 AND ${CONFLICTING_LIVE} LIMIT 1`,
      [request.principal.tenantId, contextId, threadId]);
      if (conflict.rowCount) throw new ConflictException("Conversation data needs review before it can be displayed");
      const rows = (await client.query<MetaCoexistenceMessageView & { cursorKey: string }>(`WITH subject AS (
        SELECT subject_phone FROM meta_coexistence_messages WHERE tenant_id=$1 AND context_id=$2 AND subject_digest=$3
        UNION SELECT subject_phone FROM meta_coexistence_contacts WHERE tenant_id=$1 AND context_id=$2 AND subject_digest=$3
      ), retained AS (
        SELECT m.id,m.external_message_id,m.provider_timestamp,m.direction,CASE WHEN m.echo_observed THEN 'ECHO' ELSE m.source END AS source,m.message_type,m.message_text,
          CASE WHEN m.media_id IS NOT NULL THEN 'REFERENCE_ONLY' WHEN m.message_type='media_placeholder' THEN 'PLACEHOLDER' ELSE 'NOT_APPLICABLE' END AS media,2 AS priority
        FROM meta_coexistence_messages m WHERE m.tenant_id=$1 AND m.context_id=$2 AND m.subject_digest=$3
          AND NOT app.meta_coexistence_subject_blocked($2,m.subject_phone,m.source,m.provider_timestamp)
          AND NOT EXISTS(SELECT 1 FROM normalized_messages live WHERE live.tenant_id=m.tenant_id AND live.connection_id=m.connection_id
            AND live.external_message_id=m.external_message_id AND (live.from_me<>(m.direction='OUTBOUND')
              OR NOT app.meta_direct_participant_matches(m.connection_id,live.external_participant_id,m.subject_phone)))
        UNION ALL SELECT live.id,live.external_message_id,live.provider_timestamp,CASE WHEN live.from_me THEN 'OUTBOUND' ELSE 'INBOUND' END,
          'LIVE','text',live.message_text,'NOT_APPLICABLE',1
        FROM normalized_messages live JOIN event_inbox source ON source.tenant_id=live.tenant_id AND source.id=live.event_inbox_id
        JOIN meta_coexistence_contexts context ON context.tenant_id=live.tenant_id AND context.connection_id=live.connection_id
        WHERE live.tenant_id=$1 AND context.id=$2 AND source.event_type='messages' AND source.meta_direct_asset IS NOT NULL
          AND EXISTS(SELECT 1 FROM subject WHERE subject_phone IS NOT NULL AND app.meta_direct_participant_matches(live.connection_id,live.external_participant_id,subject_phone)
            AND NOT app.meta_coexistence_subject_blocked(context.id,subject_phone,'ECHO',live.provider_timestamp))
      ), preferred AS (SELECT DISTINCT ON(external_message_id) * FROM retained ORDER BY external_message_id,priority),
      ordered AS (SELECT *,to_char(provider_timestamp AT TIME ZONE 'UTC','YYYYMMDDHH24MISS.US')||':'||id::text AS key FROM preferred)
      SELECT id::text,$3::text AS "threadId",direction,source,provider_timestamp::text AS timestamp,message_type AS type,message_text AS text,media,key AS "cursorKey"
      FROM ordered WHERE key>$4 ORDER BY key LIMIT $5`, [request.principal.tenantId, contextId, threadId, paging.key, paging.limit + 1])).rows;
      const output = result(rows, paging.limit, row => row.cursorKey);
      return { ...output, items: output.items.map(row => ({ id: row.id, threadId: row.threadId, direction: row.direction,
        source: row.source, timestamp: row.timestamp, type: row.type, text: row.text, media: row.media })) };
    });
  }

  @Post("consent") @Requires("connection:write") @Header("Cache-Control", "no-store")
  async stop(@Req() request: AuthenticatedRequest, @Param("connectionId") id: string, @Body() body: MetaCoexistenceConsentRequest) {
    if (!body || Object.keys(body).some(key => !["expectedRevision", "history", "contacts", "echoes"].includes(key))
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || body.history !== false || body.contacts !== false || body.echoes !== false) throw new BadRequestException("Invalid consent change");
    if (!process.env.PORTAL_PUBLIC_ORIGIN || request.headers.origin !== process.env.PORTAL_PUBLIC_ORIGIN) throw new ForbiddenException("Invalid origin");
    await this.read(request, id, async (client, contextId) => {
      await requirePrivilegedAuthentication(client, request.principal, "stopping Business app capture");
      const changed = await client.query(`UPDATE meta_coexistence_contexts SET consent_history=false,consent_contacts=false,consent_echoes=false,
        hold_reason='STOPPED',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revision=$3`,
      [request.principal.tenantId, contextId, body.expectedRevision]);
      if (changed.rowCount !== 1) throw new ConflictException("Capture changed. Refresh its status.");
    });
    return this.summary(request, id);
  }

  private read<T>(request: AuthenticatedRequest, id: string, action: (client: PoolClient, contextId: string) => Promise<T>) {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new NotFoundException();
    return this.database.withTenant(request.principal.tenantId, async client => {
      await client.query("SELECT app.lock_current_active_tenant_for_event_admission()");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${request.principal.tenantId}`]);
      const allowed = await client.query(`SELECT 1 FROM tenant_memberships member JOIN tenants tenant ON tenant.id=member.tenant_id
        WHERE member.tenant_id=$1 AND member.user_id=$2 AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin') AND tenant.state='ACTIVE' FOR SHARE OF member`,
      [request.principal.tenantId, request.principal.userId]);
      if (allowed.rowCount !== 1) throw new ForbiddenException("Connection administration requires an active owner or administrator");
      const context = (await client.query<{ id: string }>("SELECT id FROM meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2 FOR SHARE", [request.principal.tenantId, id])).rows[0];
      if (!context) throw new NotFoundException("Business app data is unavailable");
      return action(client, context.id);
    });
  }
}
const CONFLICTING_LIVE = `(live.from_me<>(imported.direction='OUTBOUND')
  OR NOT app.meta_direct_participant_matches(imported.connection_id,live.external_participant_id,imported.subject_phone)
  OR (imported.message_type='text' AND live.message_text IS DISTINCT FROM imported.message_text))`;
function page(cursor: string | undefined, limit: string | undefined) {
  const count = limit === undefined ? 50 : Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > 100 || (cursor !== undefined && (!/^[A-Za-z0-9_-]{1,256}$/u.test(cursor)))) throw new BadRequestException("Invalid page");
  const key = cursor ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  if (key.length > 100 || (key && !/^[0-9a-f:.-]+$/u.test(key))) throw new BadRequestException("Invalid page");
  return { key, limit: count };
}
function result<T>(rows: T[], limit: number, key: (row: T) => string): MetaCoexistencePage<T> {
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? Buffer.from(key(rows[limit - 1]!)).toString("base64url") : null };
}
