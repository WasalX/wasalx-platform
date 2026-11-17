import { Pool } from "pg";
import type { SecretResolver } from "./secrets.js";
import {
  recordMetric,
  recordStructuredLog,
  safeErrorCode,
} from "@wasalx/observability";

export type WahaEngine = "GOWS" | "NOWEB";
export type WahaRolloutMode = "STABLE" | "CANARY";

export type WahaWorkerConfig = {
  workerKey: string;
  engine: WahaEngine;
  baseUrl: string;
  secretReference: string;
  capacity: number;
  rolloutMode: WahaRolloutMode;
  canarySessionLimit?: number;
  heartbeatTtlSeconds: number;
};

type HeartbeatResult = {
  waha_worker_id: string;
  worker_key: string;
  engine: WahaEngine;
  health_state: "UNKNOWN" | "HEALTHY" | "UNHEALTHY";
  capacity: number;
  assigned_sessions: string | number;
  renewed_assignments: string | number;
};

export type WahaHealthProbeResult = {
  healthy: boolean;
  startedAt?: string;
  errorCode?: string;
};

export interface WahaWorkerHeartbeatStore {
  report(config: WahaWorkerConfig, result: WahaHealthProbeResult): Promise<void>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class WahaWorkerRegistryRepository implements WahaWorkerHeartbeatStore {
  constructor(private readonly pool: Pool) {}

  async report(config: WahaWorkerConfig, result: WahaHealthProbeResult) {
    const row = (
      await this.pool.query<HeartbeatResult>(
        `WITH heartbeat AS MATERIALIZED (
           SELECT * FROM app.report_waha_worker_heartbeat(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
           )
         ), renewal AS MATERIALIZED (
           SELECT app.renew_waha_worker_assignments(heartbeat.worker_key,interval '120 seconds')
             AS renewed_assignments FROM heartbeat
         )
         SELECT heartbeat.waha_worker_id,heartbeat.worker_key,heartbeat.engine,
                heartbeat.health_state,heartbeat.capacity,
                heartbeat.assigned_sessions,renewal.renewed_assignments
           FROM heartbeat CROSS JOIN renewal`,
        [
          config.workerKey,
          config.engine,
          config.baseUrl,
          config.secretReference,
          config.capacity,
          config.rolloutMode,
          config.canarySessionLimit ?? null,
          config.heartbeatTtlSeconds,
          result.healthy,
          result.startedAt ?? null,
          result.healthy ? null : result.errorCode ?? "WAHA_HEALTH_FAILED",
        ],
      )
    ).rows[0];
    if (!row || row.worker_key !== config.workerKey || row.engine !== config.engine) {
      throw new Error("WAHA worker heartbeat was not persisted");
    }
    const assignedSessions = Number(row.assigned_sessions);
    const renewedAssignments=Number(row.renewed_assignments);
    if (!Number.isSafeInteger(assignedSessions) || assignedSessions < 0
      ||!Number.isSafeInteger(renewedAssignments)||renewedAssignments<0
      ||renewedAssignments>assignedSessions) {
      throw new Error("WAHA worker heartbeat returned an invalid session count");
    }
    try {
      recordMetric("wasalx_waha_worker_sessions", assignedSessions, {
        worker: config.workerKey,
        engine: config.engine.toLowerCase(),
      });
    } catch (error) {
      // Registry persistence is authoritative. Telemetry export remains
      // best-effort and must never cause a duplicate heartbeat retry.
      recordStructuredLog("error", "waha_worker.session_metric_failed", {
        worker: config.workerKey,
        error_code: safeErrorCode(error),
      });
    }
  }

  async ready() {
    return (await this.pool.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok === 1;
  }

  async close() {
    await this.pool.end();
  }
}

export class WahaWorkerMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private completedFirstTick = false;

  constructor(
    private readonly configs: readonly WahaWorkerConfig[],
    private readonly repository: WahaWorkerHeartbeatStore,
    private readonly secrets: SecretResolver,
    private readonly intervalMs = 15_000,
    private readonly probeTimeoutMs = 5_000,
  ) {
    if (configs.length < 1 || configs.length > 100) {
      throw new Error("At least one and at most 100 WAHA workers must be configured");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 300_000) {
      throw new Error("WAHA worker monitor interval is invalid");
    }
    if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1_000 || probeTimeoutMs > 30_000) {
      throw new Error("WAHA worker probe timeout is invalid");
    }
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  ready() {
    return this.completedFirstTick;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const results = await Promise.allSettled(
        this.configs.map(async (config) => {
          let result: WahaHealthProbeResult;
          try {
            const secret = await this.secrets.resolve(config.secretReference,{kind:"exact",expectedReference:config.secretReference});
            if (!secret.apiKey || secret.apiKey.length > 4_096) {
              result = { healthy: false, errorCode: "WAHA_SECRET_INVALID" };
            } else {
              result = await probeWahaWorker(config.baseUrl, secret.apiKey, this.probeTimeoutMs);
            }
          } catch (error) {
            result = { healthy: false, errorCode: healthErrorCode(error) };
          }
          await this.repository.report(config, result);
          try {
            recordMetric("wasalx_waha_worker_health", result.healthy ? 1 : 0, {
              worker: config.workerKey,
              engine: config.engine.toLowerCase(),
            });
            recordMetric("wasalx_waha_worker_capacity", config.capacity, {
              worker: config.workerKey,
              engine: config.engine.toLowerCase(),
            });
          } catch (error) {
            // Telemetry must never turn a successfully persisted heartbeat
            // into a registry failure or block capacity reconciliation.
            recordStructuredLog("error", "waha_worker.telemetry_failed", {
              worker: config.workerKey,
              error_code: safeErrorCode(error),
            });
          }
          return result;
        }),
      );
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result?.status === "rejected") {
          recordStructuredLog("error", "waha_worker.heartbeat_persist_failed", {
            worker: this.configs[index]?.workerKey ?? "unknown",
            error_code: safeErrorCode(result.reason),
          });
        }
      }
      // A persisted unhealthy probe is a valid reconciliation result, while a
      // database/reporting failure is not. Readiness remains false until every
      // configured node has at least one durable registry observation.
      this.completedFirstTick = results.every((result) => result.status === "fulfilled");
    } finally {
      this.running = false;
    }
  }
}

export function parseWahaWorkerConfigs(
  environment: NodeJS.ProcessEnv = process.env,
): WahaWorkerConfig[] {
  const raw = environment.WAHA_WORKERS_JSON;
  let values: unknown;
  if (!raw) {
    if (environment.NODE_ENV === "production") {
      throw new Error("WAHA_WORKERS_JSON is required in production");
    }
    const baseUrl = environment.WAHA_BASE_URL;
    const secretReference = environment.WAHA_ADMIN_SECRET_REFERENCE;
    if (!baseUrl || !secretReference) {
      throw new Error("WAHA worker configuration is required");
    }
    values = [
      {
        workerKey: environment.WAHA_WORKER_ID ?? "wasalx-development-gows",
        engine: environment.WAHA_DEFAULT_ENGINE ?? "GOWS",
        baseUrl,
        secretReference,
        capacity: Number(environment.WAHA_WORKER_CAPACITY ?? 100),
        rolloutMode: "STABLE",
        heartbeatTtlSeconds: Number(environment.WAHA_WORKER_HEARTBEAT_TTL_SECONDS ?? 45),
      },
    ];
  } else {
    try {
      values = JSON.parse(raw);
    } catch {
      throw new Error("WAHA_WORKERS_JSON must be valid JSON");
    }
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new Error("WAHA_WORKERS_JSON must contain between 1 and 100 workers");
  }

  const workerKeys = new Set<string>();
  const endpoints = new Set<string>();
  return values.map((value, index) => {
    if (!isRecord(value)) throw new Error(`WAHA worker ${index} is invalid`);
    const workerKey = requiredString(value.workerKey, "workerKey", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workerKey)) {
      throw new Error(`WAHA worker ${workerKey} has an invalid key`);
    }
    if (workerKeys.has(workerKey)) throw new Error(`WAHA worker key ${workerKey} is duplicated`);
    workerKeys.add(workerKey);

    const engine = value.engine;
    if (engine !== "GOWS" && engine !== "NOWEB") {
      throw new Error(`WAHA worker ${workerKey} has an invalid engine`);
    }
    const baseUrl = privateWorkerBaseUrl(requiredString(value.baseUrl, "baseUrl", 2_048)).toString();
    if (endpoints.has(baseUrl)) throw new Error(`WAHA worker endpoint ${baseUrl} is duplicated`);
    endpoints.add(baseUrl);
    const secretReference = requiredString(value.secretReference, "secretReference", 512);
    if (!/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{0,510}$/.test(secretReference)) {
      throw new Error(`WAHA worker ${workerKey} has an invalid secret reference`);
    }
    const capacity = boundedInteger(value.capacity, 1, 10_000, "capacity");
    const rolloutMode = value.rolloutMode ?? "STABLE";
    if (rolloutMode !== "STABLE" && rolloutMode !== "CANARY") {
      throw new Error(`WAHA worker ${workerKey} has an invalid rollout mode`);
    }
    const canarySessionLimit = value.canarySessionLimit === undefined
      ? undefined
      : boundedInteger(value.canarySessionLimit, 1, capacity, "canarySessionLimit");
    if (
      (rolloutMode === "STABLE" && canarySessionLimit !== undefined) ||
      (rolloutMode === "CANARY" && canarySessionLimit === undefined)
    ) {
      throw new Error(`WAHA worker ${workerKey} has an invalid canary limit`);
    }
    const heartbeatTtlSeconds = boundedInteger(
      value.heartbeatTtlSeconds ?? 45,
      15,
      300,
      "heartbeatTtlSeconds",
    );
    return {
      workerKey,
      engine,
      baseUrl,
      secretReference,
      capacity,
      rolloutMode,
      ...(canarySessionLimit === undefined ? {} : { canarySessionLimit }),
      heartbeatTtlSeconds,
    };
  });
}

export async function probeWahaWorker(
  rawBaseUrl: string,
  apiKey: string,
  timeoutMs = 5_000,
  fetcher: typeof fetch = fetch,
): Promise<WahaHealthProbeResult> {
  const baseUrl = privateWorkerBaseUrl(rawBaseUrl);
  if (!apiKey || apiKey.length > 4_096) {
    return { healthy: false, errorCode: "WAHA_SECRET_INVALID" };
  }
  const healthController = new AbortController();
  const statusController = new AbortController();
  const healthTimeout = setTimeout(() => healthController.abort(), timeoutMs);
  const statusTimeout = setTimeout(() => statusController.abort(), timeoutMs);
  try {
    const headers = { "x-api-key": apiKey, accept: "application/json" };
    const healthUrl = new URL("/health", baseUrl);
    const statusUrl = new URL("/api/server/status", baseUrl);
    // These endpoints are independent observations. Probe them concurrently so
    // a slow provider health calculation cannot consume the status check's
    // entire deadline and falsely expire an otherwise working assignment.
    const [health, status] = await Promise.all([
      fetcher(healthUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: healthController.signal,
      }),
      fetcher(statusUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: statusController.signal,
      }),
    ]);
    if (!health.ok) return { healthy: false, errorCode: safeHttpCode("WAHA_HEALTH_HTTP", health.status) };
    const healthBody = await boundedJson(health);
    if (!isRecord(healthBody) || healthBody.status !== "ok") {
      return { healthy: false, errorCode: "WAHA_HEALTH_INVALID" };
    }

    if (!status.ok) return { healthy: false, errorCode: safeHttpCode("WAHA_STATUS_HTTP", status.status) };
    const statusBody = await boundedJson(status);
    const started = isRecord(statusBody) ? Number(statusBody.startTimestamp) : Number.NaN;
    if (!Number.isSafeInteger(started) || started < 1_500_000_000_000 || started > Date.now() + 60_000) {
      return { healthy: false, errorCode: "WAHA_STATUS_INVALID" };
    }
    return { healthy: true, startedAt: new Date(started).toISOString() };
  } catch (error) {
    return { healthy: false, errorCode: healthErrorCode(error) };
  } finally {
    clearTimeout(healthTimeout);
    clearTimeout(statusTimeout);
  }
}

export function privateWorkerBaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WAHA worker base URL is invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !isPrivateHost(url.hostname)
  ) {
    throw new Error("WAHA worker base URL must target a credential-free private endpoint");
  }
  return url;
}

async function boundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 65_536) throw new Error("WAHA_HEALTH_OVERSIZED");
  const body = await response.text();
  if (Buffer.byteLength(body) > 65_536) throw new Error("WAHA_HEALTH_OVERSIZED");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("WAHA_HEALTH_INVALID_JSON");
  }
}

function healthErrorCode(error: unknown) {
  if (error instanceof Error && /^WAHA_[A-Z0-9_.-]+$/.test(error.message)) {
    return error.message.slice(0, 100);
  }
  if (error instanceof Error && error.name === "AbortError") return "WAHA_HEALTH_TIMEOUT";
  return "WAHA_HEALTH_NETWORK";
}

function safeHttpCode(prefix: string, status: number) {
  const normalized = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  return `${prefix}_${normalized}`;
}

function isPrivateHost(rawHostname: string) {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".svc") ||
    hostname.endsWith(".svc.cluster.local") ||
    (!hostname.includes(".") && /^[a-z0-9][a-z0-9-]*$/.test(hostname))
  ) return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  return hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8");
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`WAHA worker ${label} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function requiredString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum) {
    throw new Error(`WAHA worker ${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
