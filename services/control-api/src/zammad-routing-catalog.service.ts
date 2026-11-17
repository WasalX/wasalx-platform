import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";
import { ZammadServiceSecretService } from "./zammad-service-secret.service.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 256;

type ZammadInstance = {
  id: string;
  tenant_id: string;
  base_url: string;
  service_secret_reference: string;
  state: string;
};

type ZammadRecord = Record<string, unknown>;

export type ZammadRoutingGroup = {
  id: string;
  name: string;
  active: boolean;
  serviceIdentityCanCreate: boolean;
};

export type ZammadRoutingOwner = {
  id: string;
  name: string;
  login: string;
  active: boolean;
  groupIds: string[];
};

export type ZammadRoutingPolicy = {
  id: string;
  name: string;
  active: boolean;
  calendarId?: string;
};

export type ZammadRoutingCalendar = {
  id: string;
  name: string;
  active: boolean;
  timezone?: string;
};

export type ZammadRoutingCatalog = {
  instanceId: string;
  fetchedAt: string;
  expiresAt: string;
  groups: ZammadRoutingGroup[];
  owners: ZammadRoutingOwner[];
  slas: ZammadRoutingPolicy[];
  calendars: ZammadRoutingCalendar[];
};

export type ZammadRoutingSelection = {
  zammadGroupId: string;
  assignmentMode: string;
  fixedOwnerId: string | null;
  slaPolicyId: string | null;
  businessHoursMode: string;
  businessHoursCalendarId: string | null;
};

type CacheEntry = { expiresAt: number; value: ZammadRoutingCatalog };

@Injectable()
export class ZammadRoutingCatalogService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<ZammadRoutingCatalog>>();
  private readonly ttlMs = boundedTtl(process.env.ZAMMAD_ROUTING_CATALOG_TTL_MS);

  constructor(
    private readonly database: DatabaseService,
    private readonly secrets: ZammadServiceSecretService,
  ) {}

  async get(tenantId: string, refresh = false) {
    const instance = await this.instance(tenantId);
    const key = `${tenantId}:${instance.id}`;
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const load = this.load(instance).then((catalog) => {
      this.insert(key, catalog);
      return catalog;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, load);
    return load;
  }

  async verifySelection(tenantId: string, selection: ZammadRoutingSelection) {
    // Activation is a state-changing trust boundary. Bypass the UI cache so a
    // group/owner/permission revoked moments ago cannot be activated from a
    // previously valid catalog snapshot.
    const catalog = await this.get(tenantId, true);
    const group = catalog.groups.find((item) => item.id === selection.zammadGroupId);
    const blockers: string[] = [];
    if (!group) blockers.push("the selected Zammad group no longer exists");
    else {
      if (!group.active) blockers.push("the selected Zammad group is inactive");
      if (!group.serviceIdentityCanCreate) blockers.push("the WasalX service identity cannot create tickets in the selected Zammad group");
    }
    if (selection.assignmentMode === "fixed_owner") {
      const owner = catalog.owners.find((item) => item.id === selection.fixedOwnerId);
      if (!owner) blockers.push("the selected fixed owner no longer exists or is not an agent");
      else if (!owner.active) blockers.push("the selected fixed owner is inactive");
      else if (!owner.groupIds.includes(selection.zammadGroupId)) blockers.push("the selected fixed owner is not assigned to the selected Zammad group");
    }
    if (selection.slaPolicyId) {
      const sla = catalog.slas.find((item) => item.id === selection.slaPolicyId);
      if (!sla) blockers.push("the selected Zammad SLA no longer exists");
      else if (!sla.active) blockers.push("the selected Zammad SLA is inactive");
    }
    if (selection.businessHoursMode === "ZAMMAD_CALENDAR") {
      const calendar = catalog.calendars.find((item) => item.id === selection.businessHoursCalendarId);
      if (!calendar) blockers.push("the selected Zammad calendar no longer exists");
      else if (!calendar.active) blockers.push("the selected Zammad calendar is inactive");
    }
    return blockers;
  }

  private async instance(tenantId: string) {
    const rows = await this.database.rows<ZammadInstance>(
      tenantId,
      `SELECT id,tenant_id,base_url,service_secret_reference,state
         FROM zammad_instances
        WHERE tenant_id=$1`,
      [tenantId],
    );
    const instance = rows[0];
    if (!instance || instance.state !== "WORKING") {
      throw new ServiceUnavailableException("The tenant Zammad workspace is not available");
    }
    return instance;
  }

  private async load(instance: ZammadInstance): Promise<ZammadRoutingCatalog> {
    let token: string;
    try {
      token = await this.secrets.resolveApiToken(instance.service_secret_reference, {tenantId:instance.tenant_id,instanceId:instance.id});
    } catch {
      throw new ServiceUnavailableException("Zammad routing credentials are unavailable");
    }
    const client = new ReadOnlyZammadCatalogClient(instance.base_url, token);
    let currentUser: ZammadRecord;
    let groups: ZammadRecord[];
    let users: ZammadRecord[];
    let slas: ZammadRecord[];
    let calendars: ZammadRecord[];
    try {
      const [identity, nativeGroups, nativeUsers, metadata] = await Promise.all([
        client.one("/api/v1/users/me"),
        client.pages("/api/v1/groups"),
        client.pages("/api/v1/users"),
        client.one("/api/v1/wasalx/service/catalog"),
      ]);
      if (!Array.isArray(metadata.slas) || !Array.isArray(metadata.calendars)) throw new Error("Invalid routing metadata");
      [currentUser, groups, users, slas, calendars] = [identity, nativeGroups, nativeUsers, metadata.slas, metadata.calendars];
    } catch {
      throw new ServiceUnavailableException("Zammad routing catalogs could not be refreshed");
    }

    const serviceGroupPermissions = groupPermissions(currentUser.group_ids);
    const serviceUserId = positiveId(currentUser.id);
    const catalogGroups = groups.flatMap((group): ZammadRoutingGroup[] => {
      const id = positiveId(group.id);
      const name = safeLabel(group.name);
      if (!id || !name) return [];
      const permissions = serviceGroupPermissions.get(id) ?? [];
      return [{
        id,
        name,
        active: group.active !== false,
        serviceIdentityCanCreate: permissions.includes("full") || permissions.includes("create"),
      }];
    }).sort(byName);
    const writableGroupIds = new Set(catalogGroups.filter((group) => group.serviceIdentityCanCreate).map((group) => group.id));
    const owners = users.flatMap((user): ZammadRoutingOwner[] => {
      const id = positiveId(user.id);
      const groupIds = [...groupPermissions(user.group_ids)]
        .filter(([groupId, permissions]) => writableGroupIds.has(groupId) && permissions.includes("full"))
        .map(([groupId]) => groupId)
        .sort(numericSort);
      if (!id || id === serviceUserId || groupIds.length === 0) return [];
      const login = safeLabel(user.login) ?? `User ${id}`;
      const fullName = [safeLabel(user.firstname), safeLabel(user.lastname)].filter(Boolean).join(" ");
      return [{ id, name: fullName || login, login, active: user.active !== false, groupIds }];
    }).sort(byName);
    const policies = slas.flatMap((sla): ZammadRoutingPolicy[] => {
      const id = positiveId(sla.id);
      const name = safeLabel(sla.name);
      if (!id || !name) return [];
      const calendarId = positiveId(sla.calendar_id);
      return [{ id, name, active: sla.active !== false, ...(calendarId ? { calendarId } : {}) }];
    }).sort(byName);
    const routingCalendars = calendars.flatMap((calendar): ZammadRoutingCalendar[] => {
      const id = positiveId(calendar.id);
      const name = safeLabel(calendar.name);
      if (!id || !name) return [];
      const timezone = safeLabel(calendar.timezone);
      return [{ id, name, active: calendar.active !== false, ...(timezone ? { timezone } : {}) }];
    }).sort(byName);
    const fetchedAt = new Date();
    return {
      instanceId: instance.id,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + this.ttlMs).toISOString(),
      groups: catalogGroups,
      owners,
      slas: policies,
      calendars: routingCalendars,
    };
  }

  private insert(key: string, value: ZammadRoutingCatalog) {
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: Date.parse(value.expiresAt) });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}

class ReadOnlyZammadCatalogClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async one(path: string) {
    const value = await this.request(path);
    if (!isRecord(value)) throw new Error("Zammad returned an invalid catalog object");
    return value;
  }

  async pages(path: string) {
    const result: ZammadRecord[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const value = await this.request(`${path}${separator}page=${page}&per_page=${PAGE_SIZE}`);
      if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Zammad returned an invalid catalog list");
      result.push(...value);
      if (value.length < PAGE_SIZE) return result;
    }
    throw new Error("Zammad routing catalog exceeded the safe item limit");
  }

  private async request(path: string): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin || url.protocol !== new URL(this.baseUrl).protocol) {
      throw new Error("Invalid Zammad routing URL");
    }
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Token token=${this.token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Zammad catalog request failed (${response.status})`);
    if ((response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new Error("Zammad catalog response content type is invalid");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Zammad catalog response is too large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response)));
  }
}

async function boundedBody(response: Response) {
  if (!response.body) throw new Error("Zammad catalog response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Zammad catalog response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function groupPermissions(value: unknown) {
  const result = new Map<string, string[]>();
  if (!isRecord(value)) return result;
  for (const [rawId, rawPermissions] of Object.entries(value)) {
    const id = positiveId(rawId);
    if (!id || !Array.isArray(rawPermissions)) continue;
    result.set(id, rawPermissions.filter((item): item is string => typeof item === "string"));
  }
  return result;
}

function positiveId(value: unknown) {
  const result = String(value ?? "");
  return /^[1-9]\d{0,9}$/u.test(result) ? result : null;
}

function safeLabel(value: unknown) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if (!result || result.length > 256 || Array.from(result).some((character) => (character.codePointAt(0) ?? 0) < 32)) return null;
  return result;
}

function isRecord(value: unknown): value is ZammadRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byName(left: { name: string }, right: { name: string }) {
  return left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" });
}

function numericSort(left: string, right: string) {
  return Number(left) - Number(right);
}

function boundedTtl(value: string | undefined) {
  const parsed = Number(value ?? DEFAULT_TTL_MS);
  return Number.isFinite(parsed) ? Math.min(120_000, Math.max(10_000, Math.floor(parsed))) : DEFAULT_TTL_MS;
}
