import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  parseMetaLegacyMigrationRequest, parseMetaLegacyMigrationActionRequest, parseMetaLegacyMigrationCancelRequest,
  type MetaLegacyMigrationAction, type MetaLegacyMigrationActionResult, type MetaLegacyMigrationCreateResult,
  type MetaLegacyMigrationPage, type MetaLegacyMigrationView,
} from '@wasalx/core/meta-legacy-migration-contract';
import { assertMetaTransitionWriter } from './meta-account-transition.js';

type Actor = { tenantId: string; connectionId: string; userId: string; appId: string; requestId: string };
function parse<T>(parser: (input: unknown) => T, value: unknown): T {
  try { return parser(value); }
  catch { throw new BadRequestException({ code: 'META_MIGRATION_REQUEST_INVALID', message: 'Review the current migration.' }); }
}
export async function requestMetaLegacyMigration(client: PoolClient, actor: Actor, key: string, body: unknown, resolve: boolean) {
  await assertMetaTransitionWriter(client, actor);
  const request = parse(parseMetaLegacyMigrationRequest, body);
  return (await client.query<{ value: MetaLegacyMigrationCreateResult }>(
    'SELECT app.request_meta_legacy_migration($1,$2,$3,$4,$5,$6,$7) AS value',
    [actor.connectionId, actor.userId, actor.appId, key, request, actor.requestId, resolve])).rows[0]!.value;
}
export async function requestMetaLegacyMigrationAction(client: PoolClient, actor: Actor, planId: string,
  key: string, action: MetaLegacyMigrationAction, body: unknown, resolve: boolean) {
  await assertMetaTransitionWriter(client, actor);
  const request = parse(value => parseMetaLegacyMigrationActionRequest(value, action), body);
  return (await client.query<{ value: MetaLegacyMigrationActionResult }>(
    'SELECT app.request_meta_legacy_migration_action($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',
    [planId, actor.connectionId, actor.userId, actor.appId, key, action, request, actor.requestId, resolve])).rows[0]!.value;
}
export async function cancelMetaLegacyMigration(client: PoolClient, actor: Actor, planId: string, body: unknown) {
  await assertMetaTransitionWriter(client, actor);
  const request = parse(parseMetaLegacyMigrationCancelRequest, body);
  return (await client.query<{ value: { id: string; duplicate: boolean } }>(
    'SELECT app.cancel_meta_legacy_migration($1,$2,$3,$4) AS value',
    [planId, actor.connectionId, actor.userId, request.expectedRevision])).rows[0]!.value;
}
export async function readMetaLegacyMigration(client: PoolClient, actor: Actor, planId: string): Promise<MetaLegacyMigrationView> {
  const value = (await client.query<{ value: MetaLegacyMigrationView | null }>(
    'SELECT app.meta_legacy_migration_view($1,$2,$3,$4) AS value',
    [planId, actor.connectionId, actor.userId, actor.appId])).rows[0]?.value;
  if (!value) throw new NotFoundException('Migration review not found.');
  return value;
}
export async function readMetaLegacyMigrationPage(client: PoolClient, actor: Actor): Promise<MetaLegacyMigrationPage> {
  const value = (await client.query<{ value: MetaLegacyMigrationPage | null }>(
    'SELECT app.meta_legacy_migration_page($1,$2,$3) AS value', [actor.connectionId, actor.userId, actor.appId])).rows[0]?.value;
  if (!value) throw new NotFoundException('Meta connection not found.');
  return value;
}
