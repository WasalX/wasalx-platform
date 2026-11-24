import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { metaTemplateSafetyMarker } from '@wasalx/core/meta-template-continuity';
import type { DatabaseService } from './database.service.js';
import { matchesMetaWebhookApp } from './meta-webhook-apps.js';
import { sha256Hex } from './webhook-security.js';

/** Called by the existing Meta controller only AFTER exact raw HMAC validation.
 * This performs durable safety admission synchronously. It must run before any
 * later payload parser can reject another event in the same signed envelope. */
export async function admitMetaTemplateSafety(database: DatabaseService, body: unknown, appId: string | undefined, appReference?: string) {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(body) || !Array.isArray(body.entry)) return { accepted: 0, duplicates: 0, unrouted: 0 };
  let accepted = 0, duplicates = 0, unrouted = 0;
  let admissionError: unknown;
  for (const entry of body.entry) {
    if (!object(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!object(change) || typeof change.field !== 'string') continue;
      const marker = metaTemplateSafetyMarker(change.field, change.value);
      if (!marker) continue;
      try {
        if (body.object !== 'whatsapp_business_account' || typeof entry.id !== 'string' || !/^[0-9]{1,32}$/u.test(entry.id))
          throw new BadRequestException('Template event account is unavailable.');
        if (!appId || !/^[0-9]{1,32}$/u.test(appId)) throw new ServiceUnavailableException('Template verification is unavailable.');
        // The event hash retains the full signed value as a digest, never raw
        // content in a log/receipt. Malformed IDs stay exact-account negatives.
        const payloadSha256 = await sha256Hex(JSON.stringify({ object: body.object, entry: [{ id: entry.id,
          ...(entry.time === undefined ? {} : { time: entry.time }), changes: [change] }] }));
        const field = /^message_template_[A-Za-z0-9_]{1,96}$/u.test(change.field) ? change.field : 'message_template_unrecognized';
        const routes = await database.resolveMetaLifecycleRoutes(entry.id, appId);
        const tenants = new Set<string>();
        for (const route of routes) {
          if (tenants.has(route.tenant_id) || !matchesMetaWebhookApp(route, appReference)) continue;
          try {
            const result = await database.withTenant(route.tenant_id, async client => {
              if (appReference !== undefined) {
                const tenant = await client.query<{ active: boolean }>('SELECT app.lock_current_active_tenant_for_event_admission() AS active');
                if (tenant.rows[0]?.active !== true) return;
                const current = await client.query(
                  `SELECT connection_id FROM webhook_routes
                   WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND hmac_secret_reference=$3
                     AND state=$4 AND reservation_release_id IS NULL FOR SHARE`,
                  [route.tenant_id, route.connection_id, appReference, route.route_state]);
                if (current.rowCount !== 1) return;
              }
              return (await client.query<{ value: { accepted: boolean; duplicate: boolean } }>(
                'SELECT app.invalidate_meta_template_account($1,$2,$3,$4,$5,$6,$7) AS value',
                [route.connection_id, route.provider_session_id, entry.id, appId, payloadSha256, field, marker.templateId])).rows[0]?.value;
            });
            if (result?.accepted) { tenants.add(route.tenant_id); if (result.duplicate) duplicates++; else accepted++; }
          } catch (error) { admissionError ??= error; }
        }
        if (!tenants.size) unrouted++;
      } catch (error) { admissionError ??= error; }
    }
  }
  // A bad sibling never discards a later attributable safety marker. Report
  // the original admission failure only after every signed sibling was visited.
  if (admissionError !== undefined) throw admissionError;
  return { accepted, duplicates, unrouted };
}
