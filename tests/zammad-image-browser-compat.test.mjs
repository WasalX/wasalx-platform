import {requiredOperatorInput} from "../scripts/release/operator-input.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { assertNativeCompatibilityProjectEmpty, settleNativeCompatibility } from "./fixtures/native-compat-cleanup.mjs";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { prepareMailboxFixture } from "../scripts/contracts/prepare-mailbox-tls-fixture.mjs";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";

const image = process.env.WASALX_ZAMMAD_TEST_IMAGE;
const imagePattern = /^[a-z0-9][a-z0-9._/:@-]{1,255}$/iu;
if (!image || !imagePattern.test(image)) throw new Error("WASALX_ZAMMAD_TEST_IMAGE is required");
const fixturePort = Number(process.env.WASALX_ZAMMAD_FIXTURE_PORT ?? 0);
if (!Number.isSafeInteger(fixturePort) || fixturePort < 0 || fixturePort > 65_535) throw new Error("WASALX_ZAMMAD_FIXTURE_PORT is invalid");
const runnerContainer = process.env.WASALX_ZAMMAD_RUNNER_CONTAINER;
if (runnerContainer && !/^[a-z0-9][a-z0-9_.-]{1,127}$/iu.test(runnerContainer)) throw new Error("WASALX_ZAMMAD_RUNNER_CONTAINER is invalid");

const groupId = "12000000-0000-4000-8000-000000000001";
const existingMessageId = "13000000-0000-4000-8000-000000000001";
const createMessageId = "13000000-0000-4000-8000-000000000002";
const linkMessageId = "13000000-0000-4000-8000-000000000003";
const closedMessageId = "13000000-0000-4000-8000-000000000004";
const olderMessageId = "13000000-0000-4000-8000-000000000005";
const connectionId = "11000000-0000-4000-8000-000000000001";
const tenantId = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000003";
const bootstrapEmail = "fixture-0043@example.test";
const bootstrapSubject = "wasalx-compat-owner";
const bootstrapPassword = "WasalX-compat-admin-2026";
const legacyBootstrapEmail = "fixture-0044@example.test";
const legacyBootstrapPassword = "WasalX-compat-legacy-admin-2026";
const agentEmail = "fixture-0045@example.test";
const agentPassword = "WasalX-compat-agent-2026";
const createParticipantId = "12125550103@c.us";
const createCustomerLogin = `wasalx-${createHash("sha256").update(`${tenantId}\u001f${connectionId}\u001f${createParticipantId}`).digest("hex")}`;
const stagedUploadId = "15000000-0000-4000-8000-000000000001";
const staleUploadId = "15000000-0000-4000-8000-000000000002";
const serviceToken = "wasalx-zammad-compat-service-token";
const restrictedToken = "wasalx-zammad-compat-restricted-token";
const modernEntryConfigPath = join(process.cwd(), "infra", "docker", "full", "zammad", "nginx-diagnostic-entry.conf");
const compatibility = JSON.parse(await readFile(join(process.cwd(), "zammad-package", "compatibility-artifacts.json"), "utf8"));
const predecessorVersion = "0.5.36";
const rollbackVersion = "0.5.13";
const predecessorArtifact = compatibility.artifacts[predecessorVersion];
const rollbackArtifact = compatibility.artifacts[rollbackVersion];
const execFileAsync = promisify(execFile);
// Finite commands inherit 4 GiB; resident services keep the isolated stack bounded.
const resourceCaps = {
  "mailbox-tls-fixture": { memory: 128 * 1024 ** 2, cpus: 0.5 },
  "zammad-postgresql": { memory: 1024 ** 3, cpus: 1 },
  "zammad-redis": { memory: 256 * 1024 ** 2, cpus: 0.5 },
  "zammad-memcached": { memory: 256 * 1024 ** 2, cpus: 0.5 },
  "zammad-railsserver": { memory: 3 * 1024 ** 3, cpus: 2 },
  "zammad-websocket": { memory: 1536 * 1024 ** 2, cpus: 1 },
  // The pinned Nginx entrypoint boots Rails for readiness before starting Nginx.
  "zammad-nginx": { memory: 1024 ** 3, cpus: 0.5 },
};
const finiteCap = { memory: 4 * 1024 ** 3, cpus: 2 };
const composeCap = ({ memory, cpus }) => `mem_limit: ${memory}
    memswap_limit: ${memory}
    cpus: ${cpus}`;

function docker(directory, project, ...args) {
  return execFileSync("docker", ["compose", "--project-directory", directory, "--project-name", project, "--file", join(directory, "compose.yaml"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WASALX_ZAMMAD_TEST_IMAGE: image },
    timeout: 1_800_000, killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function dockerAsync(directory, project, ...args) {
  const result = await execFileAsync("docker", ["compose", "--project-directory", directory, "--project-name", project, "--file", join(directory, "compose.yaml"), ...args], {
    encoding: "utf8",
    env: { ...process.env, WASALX_ZAMMAD_TEST_IMAGE: image },
    timeout: 1_800_000, killSignal: "SIGKILL",
  });
  return (typeof result === "string" ? result : result.stdout).trim();
}

function rejectedDocker(directory, project, ...args) {
  try {
    docker(directory, project, ...args);
  } catch (error) {
    if (error?.code === "ETIMEDOUT" || error?.signal || !Number.isInteger(error?.status) || error.status <= 0) throw error;
    return [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
  }
  throw new Error(`Docker command unexpectedly succeeded: ${args.join(" ")}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function fixtureEndpoint() {
  if (runnerContainer || process.platform !== "linux") {
    return { listenHost: "0.0.0.0", gateway: "host-gateway" };
  }
  const securityOptions = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" }));
  if (securityOptions.includes("name=rootless")) {
    const route = execFileSync("ip", ["-4", "route", "get", "1.1.1.1"], { encoding: "utf8" });
    const host = /\bsrc\s+(\d+(?:\.\d+){3})\b/u.exec(route)?.[1];
    assert.equal(isIP(host), 4, "Docker host route is unavailable");
    return { listenHost: host, gateway: host };
  }
  const gateway = execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" }).trim();
  assert.equal(isIP(gateway), 4, "Docker bridge gateway is unavailable");
  return { listenHost: "0.0.0.0", gateway };
}

function compose(port, fixturePort, fixtureGateway, predecessorPackagePath, rollbackPackagePath) {
  const fixtureHost = runnerContainer ? "wasalx-fixture" : "host.docker.internal";
  return `
x-environment: &environment
  MEMCACHE_SERVERS: zammad-memcached:11211
  POSTGRESQL_DB: zammad_production
  POSTGRESQL_HOST: zammad-postgresql
  POSTGRESQL_USER: zammad
  POSTGRESQL_PASS: zammad-compat-db
  POSTGRESQL_PORT: "5432"
  RAILS_CHECK_PENDING_MIGRATIONS: "true"
  TMP: /opt/zammad/tmp/wasalx
  REDIS_URL: redis://zammad-redis:6379
  ELASTICSEARCH_ENABLED: "false"
  ZAMMAD_HTTP_TYPE: http
  ZAMMAD_FQDN: ${runnerContainer ? "zammad-nginx:8080" : `127.0.0.1:${port}`}
  NGINX_PORT: "8080"
  TZ: Asia/Riyadh
  WASALX_CONTROL_URL: http://${fixtureHost}:${fixturePort}
  WASALX_PORTAL_URL: https://portal.compat.wasalx.invalid
  WASALX_TENANT_ID: ${tenantId}
  WASALX_ZAMMAD_INSTANCE_ID: ${instanceId}
  WASALX_SERVICE_JWT_SECRET: wasalx-zammad-compat-jwt-secret
x-service: &service
  image: \${WASALX_ZAMMAD_TEST_IMAGE}
  environment: *environment
  ${composeCap(finiteCap).replaceAll("\n    ", "\n  ")}
  tmpfs: ["/opt/zammad/tmp:rw,size=512m,mode=2777,uid=0,gid=1000"]
  ${runnerContainer ? "" : `extra_hosts: ["host.docker.internal:${fixtureGateway}"]`}
  volumes:
    - zammad-storage:/opt/zammad/storage
    - zammad-backup:/var/tmp/zammad
services:
  zammad-postgresql:
    ${composeCap(resourceCaps["zammad-postgresql"]) }
    image: postgres:17.10-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
    environment: { POSTGRES_DB: zammad_production, POSTGRES_USER: zammad, POSTGRES_PASSWORD: zammad-compat-db }
    command: [postgres, -c, fsync=off, -c, synchronous_commit=off, -c, full_page_writes=off]
    tmpfs: [/var/lib/postgresql/data]
    healthcheck: { test: [CMD-SHELL, "pg_isready -h 127.0.0.1 -U zammad -d zammad_production"], interval: 2s, timeout: 3s, retries: 30 }
  zammad-redis:
    ${composeCap(resourceCaps["zammad-redis"]) }
    image: redis:8.10-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241
    tmpfs: [/data]
    healthcheck: { test: [CMD, redis-cli, ping], interval: 2s, timeout: 3s, retries: 30 }
  zammad-memcached:
    ${composeCap(resourceCaps["zammad-memcached"]) }
    image: memcached:1.6.45-alpine@sha256:c29847751abb41f4c268c84fb3087fee05d4edcbda44409ccb5086e26148e8a7
    healthcheck: { test: [CMD, nc, -z, 127.0.0.1, "11211"], interval: 2s, timeout: 3s, retries: 30 }
  zammad-init:
    <<: *service
    command: [zammad-init]
    user: 0:0
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    environment:
      <<: *environment
      RAILS_CHECK_PENDING_MIGRATIONS: "false"
  zammad-package:
    <<: *service
    command: [wasalx-package-install]
  zammad-package-predecessor:
    <<: *service
    command: [wasalx-package-install]
    environment:
      <<: *environment
      WASALX_ZPM_PATH: /compat/${predecessorArtifact.path.split("/").at(-1)}
      WASALX_PACKAGE_VERSION: "${predecessorVersion}"
      WASALX_PACKAGE_SHA256: ${predecessorArtifact.sha256}
    volumes:
      - zammad-storage:/opt/zammad/storage
      - zammad-backup:/var/tmp/zammad
      - type: bind
        source: ${JSON.stringify(predecessorPackagePath)}
        target: /compat/${predecessorArtifact.path.split("/").at(-1)}
        read_only: true
  zammad-package-rollback:
    <<: *service
    command: [wasalx-package-install]
    environment:
      <<: *environment
      WASALX_ZPM_PATH: /compat/${rollbackArtifact.path.split("/").at(-1)}
      WASALX_PACKAGE_VERSION: "${rollbackVersion}"
      WASALX_PACKAGE_SHA256: ${rollbackArtifact.sha256}
    volumes:
      - zammad-storage:/opt/zammad/storage
      - zammad-backup:/var/tmp/zammad
      - type: bind
        source: ${JSON.stringify(rollbackPackagePath)}
        target: /compat/${rollbackArtifact.path.split("/").at(-1)}
        read_only: true
  zammad-bootstrap:
    <<: *service
    command: [bash, /usr/local/bin/wasalx-runtime-bootstrap]
    environment:
      <<: *environment
      WASALX_ZAMMAD_BOOTSTRAP_EMAIL: ${bootstrapEmail}
      WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT: ${bootstrapSubject}
      WASALX_ZAMMAD_BOOTSTRAP_NAME: Compatibility Administrator
      WASALX_ZAMMAD_BOOTSTRAP_PASSWORD: ${bootstrapPassword}
      WASALX_ZAMMAD_BOOTSTRAP_PREVIOUS_EMAIL: ${legacyBootstrapEmail}
      WASALX_ZAMMAD_AGENT_EMAIL: ${agentEmail}
      WASALX_ZAMMAD_AGENT_NAME: Compatibility Agent
      WASALX_ZAMMAD_AGENT_PASSWORD: ${agentPassword}
      ZAMMAD_SERVICE_TOKEN: wasalx-zammad-compat-service-token
      ZAMMAD_PRIVACY_TOKEN: wasalx-zammad-compat-privacy-token
  zammad-railsserver:
    <<: *service
    ${composeCap(resourceCaps["zammad-railsserver"]) }
    command: [zammad-railsserver]
    healthcheck: { test: [CMD, curl, --fail, --silent, http://127.0.0.1:3000], interval: 5s, timeout: 5s, start_period: 60s, retries: 30 }
  zammad-websocket:
    <<: *service
    ${composeCap(resourceCaps["zammad-websocket"]) }
    command: [zammad-websocket]
  zammad-nginx:
    <<: *service
    ${composeCap(resourceCaps["zammad-nginx"]) }
    command: [zammad-nginx]
    ports: ["127.0.0.1:${port}:8080"]
    volumes:
      - zammad-storage:/opt/zammad/storage
      - zammad-backup:/var/tmp/zammad
      - type: bind
        source: ${JSON.stringify(modernEntryConfigPath)}
        target: /opt/zammad/contrib/nginx/zammad.conf
        read_only: true
    healthcheck: { test: [CMD, curl, --fail, --silent, http://127.0.0.1:8080/desktop], interval: 5s, timeout: 5s, start_period: 30s, retries: 30 }
volumes: { zammad-storage: {}, zammad-backup: {} }
`;
}

test("package upgrade, route, and group workspace operate in the immutable Zammad image", { timeout: 1_800_000 }, async () => {
  const nativeCloseScenario = await readFile(join(process.cwd(), "tests", "native-close-rails-scenario.rb"), "utf8");
  const project = `wasalx-zammad-${randomUUID()}`;
  const admission = assertNativeCompatibilityProjectEmpty({ project,
    command: (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"] }),
  });
  process.stdout.write(`${JSON.stringify({ fixture: "native-project-admission", ...admission })}\n`);
  const directory = await mkdtemp(join(tmpdir(), "wasalx-zammad-browser-"));
  const evidenceDirectory = join(process.cwd(), "output", "zammad-compat", image.replaceAll(/[^a-z0-9.-]/giu, "_"));
  const port = await availablePort();
  const fixtureEndpointAddress = fixtureEndpoint();
  let browser;
  let fixture;
  let runnerConnected = false;
  let primaryError;
  const groupActorExpectations = new Map();
  const observedGroupActors = new Set();
  const state = { customerId: null, ticketId: null, ticketNumber: null, articleId: null, closedTicketId: null, closedTicketNumber: null, closedArticleId: null, links: [], requests: [], sentMessages: [], liveMessages: [] };
  try {
    fixture = createServer(async (request, response) => {
      const body = [];
      for await (const chunk of request) body.push(chunk);
      const raw = Buffer.concat(body).toString("utf8");
      const url = new URL(request.url ?? "/", "http://fixture");
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer ")) { response.writeHead(401).end(); return; }
      const claims = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString("utf8"));
      assert.equal(claims.tenant_id, tenantId);
      assert.equal(claims.instance_id, instanceId);
      if (claims.scope === "zammad:groups") {
        const actorId = String(claims.zammad_user_id);
        assert.ok(groupActorExpectations.has(actorId), "unexpected group actor");
        assert.equal(claims.zammad_group_admin, groupActorExpectations.get(actorId));
        observedGroupActors.add(actorId);
      }
      state.requests.push({ method: request.method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : null });
      if (url.pathname === "/internal/v1/zammad/group-workspace/groups/00000000-0000-4000-8000-000000000000/messages") {
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "private-upstream-marker" }));
        return;
      }
      const messages = [
        ...state.liveMessages,
        ...state.sentMessages,
        { id: closedMessageId, participant_name: "Noura", message_text: "Resolved shipment SHIP-40", from_me: false, provider_timestamp: "2026-08-20T10:03:00.000Z", latest_mutation: null, quote_allowed: true, ticket_creatable: false, linked_to_ticket: true },
        { id: linkMessageId, participant_name: "Fatima", message_text: "Link shipment SHIP-43", from_me: false, provider_timestamp: "2026-08-20T10:02:00.000Z", latest_mutation: null, quote_allowed: true, ticket_creatable: true, linked_to_ticket: false },
        { id: createMessageId, participant_name: "Omar", message_text: "Create shipment SHIP-42", from_me: false, provider_timestamp: "2026-08-20T10:01:00.000Z", latest_mutation: null, quote_allowed: true, ticket_creatable: true, linked_to_ticket: false },
        { id: existingMessageId, participant_name: "Sara", message_text: "Existing shipment SHIP-41", from_me: false, provider_timestamp: "2026-08-20T10:00:00.000Z", latest_mutation: null, quote_allowed: true, ticket_creatable: false, linked_to_ticket: true },
        ...Array.from({ length: 46 }, (_, index) => ({ id: `16000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, participant_name: "Archive", message_text: `Earlier message ${index}`, from_me: false, provider_timestamp: `2026-08-19T09:${String(index).padStart(2, "0")}:00.000Z`, latest_mutation: null, quote_allowed: true, ticket_creatable: true, linked_to_ticket: false })),
      ];
      let value;
      if (request.method === "GET" && url.pathname === "/internal/v1/zammad/outbound/preflight") {
        assert.equal(claims.scope, "zammad:outbound");
        assert.ok(Number(claims.zammad_user_id) > 0);
        assert.equal(url.searchParams.get("connection_id"), connectionId);
        assert.equal(url.searchParams.get("group_id"), Number(url.searchParams.get("ticket_id")) === state.directReplyTicketId
          ? "12125550104@c.us" : "120363118@g.us");
        assert.match(url.searchParams.get("ticket_id") ?? "", /^[1-9]\d*$/u);
        value = { available: true };
      }
      else if (request.method === "POST" && url.pathname === "/internal/v1/zammad/outbound") {
        const payload = JSON.parse(raw); assert.equal(claims.scope, "zammad:outbound");
        const direct = Number(payload.ticket_id) === state.directReplyTicketId;
        assert.ok(direct || Number(payload.ticket_id) === Number(state.ticketId));
        assert.ok(Number.isSafeInteger(payload.article_id) && payload.article_id > 0);
        assert.equal(payload.idempotency_key, `zammad:${tenantId}:${instanceId}:${payload.ticket_id}:${payload.article_id}`);
        assert.ok(payload.body.includes(direct ? "WX-NATIVE-DIRECT-RESET" : "WX-NATIVE-NEW-PDF-RESET"));
        assert.equal(payload.attachments.length, direct ? 0 : 1);
        if (!direct) assert.equal(payload.attachments[0].content_type, "application/pdf");
        value = { id: "14000000-0000-4000-8000-000000000099", state: "QUEUED" };
      }
      else if (request.method === "GET" && [state.ticketId, state.directReplyTicketId].some(id => id != null
        && url.pathname === `/internal/v1/zammad/tickets/${id}/context`)) value = {
        ticket_id: Number(url.pathname.split("/").at(-2)), connection_id: connectionId, provider: "WAHA", connection_state: "WORKING",
        binding_state: "ACTIVE", correlation_state: "OPEN", group_name: "Riyadh Operations", delivery_state: "SENT",
        ...(url.pathname === `/internal/v1/zammad/tickets/${state.directReplyTicketId}/context` ? { bot_state: state.directBotState } : {}),
        delivery_id: null, zammad_article_id: state.articleId, delivery_retry_allowed: false,
        delivery_retry_requires_confirmation: false, last_heartbeat_at: "2026-08-20T10:04:00.000Z",
        last_provider_event_at: "2026-08-20T10:03:00.000Z", delivery_updated_at: "2026-08-20T10:03:00.000Z",
      };
      else if (request.method === "GET" && url.pathname === `/internal/v1/zammad/group-workspace/tickets/${state.ticketId}/message-context`) value = {
        group_id: groupId, message_id: existingMessageId,
      };
      else if (request.method === "GET" && url.pathname.endsWith("/group-workspace/groups")) {
        assert.equal(url.searchParams.get("limit"), "50");
        assert.ok(["MY", "TEAM", "UNASSIGNED", "ALL"].includes(url.searchParams.get("scope") ?? ""));
        value = { items: [{ id: groupId, name: "Riyadh Operations", access_scope: "MY", unread_count: 2, send_available: true,
          media_capabilities: { accepted: [{ mime_type: "image/png", maximum_bytes: 15_000_000 }, { mime_type: "audio/webm", maximum_bytes: 25_000_000 }], voice_recording: true, maximum_files: 10, maximum_total_bytes: 250_000_000 } }], next_cursor: null };
      }
      else if (request.method === "GET" && url.pathname.endsWith("/participants")) value = [{ id: "12025550102@lid", name: "Customer One" }];
      else if (request.method === "GET" && url.pathname.endsWith("/messages")) value = url.searchParams.has("before")
        ? [{ id: olderMessageId, participant_name: "Majed", message_text: "Archived shipment SHIP-39", from_me: false, provider_timestamp: "2026-08-20T09:59:00.000Z", latest_mutation: null, quote_allowed: true, ticket_creatable: true, linked_to_ticket: false }]
        : messages;
      else if (request.method === "GET" && url.pathname.endsWith("/context")) value = messages;
      else if (request.method === "GET" && url.pathname.endsWith("/tickets")) value = {
        items: [...Map.groupBy(state.links, (link) => link.ticketId)].map(([ticketId, links]) => ({
          ticket_id: ticketId,
          links: links.map((link) => ({ message_id: link.messageId, article_id: link.articleId })),
        })),
        next_cursor: null,
      };
      else if (request.method === "GET" && url.pathname.endsWith("/source")) {
        const message = messages.find((candidate) => url.pathname.includes(candidate.id));
        value = { ...message, connection_id: connectionId, external_group_id: "120363118@g.us", group_name: "Riyadh Operations", provider: "WAHA", external_message_id: message?.id,
          external_participant_id: message?.id === createMessageId ? createParticipantId : "12125550104@c.us",
          zammad_customer_id: message?.id === createMessageId ? null : state.customerId,
          links: state.links.filter((link) => link.messageId === message?.id).map((link) => ({ ticket_id: link.ticketId, article_id: link.articleId })) };
      } else if (request.method === "POST" && url.pathname.endsWith("/tickets")) {
        const payload = JSON.parse(raw);
        const messageId = url.pathname.split("/").at(-2);
        state.links.push({ messageId, ticketId: String(payload.ticketId), articleId: String(payload.articleId) });
        value = { linked: true };
      } else if (request.method === "POST" && url.pathname.endsWith("/send")) {
        const payload = JSON.parse(raw);
        const attachment = payload.attachments?.[0];
        value = {
          id: `14000000-0000-4000-8000-${String(state.sentMessages.length + 1).padStart(12, "0")}`,
          external_message_id: null,
          participant_name: "Compatibility Owner",
          message_text: payload.message,
          from_me: true,
          provider_timestamp: "2026-08-20T10:03:00.000Z",
          latest_mutation: null,
          quote_allowed: false,
          ticket_creatable: false,
          linked_to_ticket: false,
          source_kind: "DELIVERY",
          delivery_state: "QUEUED",
          ...(attachment ? { media_filename: attachment.filename, media_mime_type: attachment.mimeType, media_available: false } : {}),
        };
        state.sentMessages = [value, ...state.sentMessages];
      } else if (request.method === "POST" && url.pathname.endsWith("/read")) value = { state: "QUEUED" };
      else { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    });
    await new Promise((resolve, reject) => fixture.once("error", reject).listen(fixturePort, fixtureEndpointAddress.listenHost, resolve));
    const fixtureAddress = fixture.address();
    assert.ok(fixtureAddress && typeof fixtureAddress === "object");
    execFileSync(process.execPath, ["scripts/prepare-zammad-compatibility-artifacts.mjs", "--output-root", directory, predecessorVersion, rollbackVersion], {
      cwd: process.cwd(),
      timeout: 120_000, killSignal: "SIGKILL",
      stdio: "inherit",
    });
    const predecessorPackagePath = join(directory, predecessorArtifact.path.split("/").at(-1));
    const rollbackPackagePath = join(directory, rollbackArtifact.path.split("/").at(-1));
    const mailboxFixture = await prepareMailboxFixture(directory);
    const composeDocument = parseYaml(compose(port, fixtureAddress.port, fixtureEndpointAddress.gateway, predecessorPackagePath, rollbackPackagePath), { merge: true });
    composeDocument.services["mailbox-tls-fixture"] = mailboxFixture.service;
    composeDocument.networks = { default: {}, ...composeDocument.networks, ...mailboxFixture.networks };
    const nativeService = composeDocument.services["zammad-package"];
    nativeService.environment = { ...nativeService.environment, ...mailboxFixture.nativeEnvironment };
    nativeService.volumes = [...nativeService.volumes, ...mailboxFixture.nativeVolumes];
    nativeService.networks = mailboxFixture.nativeNetworks;
    await writeFile(join(directory, "compose.yaml"), stringifyYaml(composeDocument), { mode: 0o600 });
    const privateAuth = JSON.parse(await readFile(join(mailboxFixture.privateDir, "auth.json"), "utf8"));
    const privateControl = (await readFile(join(mailboxFixture.privateDir, "control-token"), "utf8")).trim();
    const privateNative = async (...args) => {
      try {
        const output = await dockerAsync(directory, project, ...args);
        assert.ok(!output.includes(privateAuth.password) && !output.includes(privateControl), "Fixture secret entered native diagnostics");
        return output;
      } catch (error) {
        const diagnostics = [error?.message, error?.stdout, error?.stderr].filter(value => typeof value === "string").join("\n");
        if (diagnostics.includes(privateAuth.password) || diagnostics.includes(privateControl)) throw new Error("Native fixture diagnostics contained a secret; output suppressed");
        throw error;
      }
    };

    await mkdir(evidenceDirectory, { recursive: true });
    const composeConfiguration = JSON.parse(docker(directory, project, "config", "--format", "json"));
    for (const [name, service] of Object.entries(composeConfiguration.services)) {
      const cap = resourceCaps[name] ?? finiteCap;
      assert.equal(Number(service.mem_limit), cap.memory, `${name} memory cap`);
      assert.equal(Number(service.memswap_limit), cap.memory, `${name} swap cap`);
      assert.equal(Number(service.cpus), cap.cpus, `${name} CPU cap`);
    }
    await writeFile(join(evidenceDirectory, "resource-caps.json"), JSON.stringify({ resourceCaps, finiteCap }, null, 2));

    const membershipContract = (await readFile(join(process.cwd(), "tests/zammad-membership-contract.rb"))).toString("base64");
    const membershipProof = docker(directory, project, "run", "--rm", "--no-deps", "--entrypoint", "ruby",
      "--env", "WASALX_TEST_PACKAGE_ROOT=/opt/zammad", "--env", "WASALX_TEST_NATIVE_ROOT=/opt/zammad",
      "zammad-package", "-e", `require 'base64'; eval(Base64.decode64('${membershipContract}'), TOPLEVEL_BINDING, 'membership-contract.rb')`);
    assert.match(membershipProof, /0 failures, 0 errors, 0 skips/);

    const machineContract = (await readFile(join(process.cwd(), "tests/zammad-service-identity-contract.rb"))).toString("base64");
    const machineProof = docker(directory, project, "run", "--rm", "--no-deps", "--entrypoint", "ruby",
      "--env", "WASALX_TEST_PACKAGE_ROOT=/opt/zammad", "zammad-package", "-e",
      `require 'base64'; eval(Base64.decode64('${machineContract}'), TOPLEVEL_BINDING, 'service-identity-contract.rb')`);
    assert.match(machineProof, /0 failures, 0 errors, 0 skips/);

    docker(directory, project, "up", "--detach", "--wait", "zammad-postgresql", "zammad-redis", "zammad-memcached");
    assert.equal(docker(directory, project, "exec", "-T", "zammad-postgresql", "psql", "-U", "zammad", "-d", "zammad_production", "-At", "-c", "SELECT current_setting('fsync') || '|' || current_setting('synchronous_commit') || '|' || current_setting('full_page_writes')"), "off|off|off", "Disposable PostgreSQL durability settings must be effective");
    if (runnerContainer) {
      execFileSync("docker", ["network", "connect", "--alias", "wasalx-fixture", `${project}_default`, runnerContainer]);
      runnerConnected = true;
    }
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-init");
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package-predecessor");
    const predecessorState = JSON.parse(docker(
      directory, project, "exec", "-T", "zammad-postgresql", "psql", "-U", "zammad", "-d", "zammad_production", "-At", "-c", `
        SELECT json_build_object(
          'version', (SELECT version FROM packages WHERE name = 'wasalx'),
          'state', (SELECT state FROM packages WHERE name = 'wasalx'),
          'migrations', COALESCE((SELECT json_agg(version ORDER BY version) FROM package_migrations WHERE name = 'wasalx'), '[]'::json),
          'columns', COALESCE((SELECT json_agg(column_name ORDER BY column_name) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name IN (
              'wasalx_bot_conversation', 'wasalx_bot_state', 'wasalx_client_routing_version_id',
              'wasalx_client_id', 'wasalx_client_route_status', 'wasalx_client_route_matched_by'
            )), '[]'::json)
        );
      `,
    ));
    assert.deepEqual(predecessorState, {
      version: predecessorVersion,
      state: "installed",
      migrations: [
        "202608090001", "202608090002", "202608110003", "202608150004", "202608200005",
        "202608230006", "202608240007", "202608240008", "202608240009",
      ],
      columns: [],
    });
    const migrationGuard = "WasalX migration reference guard";
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package-predecessor", "bundle", "exec", "rails", "runner", `
      UserInfo.current_user_id = 1
      guard = Trigger.create!(
        name: '${migrationGuard}', active: true, execution_condition_mode: 'selective',
        activator: 'action',
        condition: { 'ticket.action' => { 'operator' => 'is', 'value' => 'create' } },
        perform: { 'ticket.priority_id' => { 'value' => Ticket::Priority.order(:id).first.id.to_s } }
      )
      guard.update_columns(
        condition: { 'ticket.wasalx_client_route_matched_by' => { 'operator' => 'is', 'value' => 'EMAIL' } }
      )
    `);
    const blockedUpgrade = rejectedDocker(directory, project, "run", "--rm", "--no-deps", "zammad-package");
    assert.match(blockedUpgrade, /wasalx_client_route_matched_by/u);
    assert.match(blockedUpgrade, /WasalX migration reference guard/u);
    const blockedState = JSON.parse(docker(directory, project, "run", "--rm", "--no-deps", "zammad-package", "bundle", "exec", "rails", "runner", `
      require 'json'
      names = %w[wasalx_client_routing_version_id wasalx_client_id wasalx_client_route_status wasalx_client_route_matched_by]
      attributes = names.map do |name|
        attribute = ObjectManager::Attribute.get(object: 'Ticket', name: name)
        screens = JSON.parse(attribute.screens.to_json)
        { name: name, active: attribute.active, view_shown: screens.dig('view', '-all-', 'shown') }
      end
      package = Package.find_by(name: 'wasalx')
      puts JSON.generate(receipt: Package::Migration.exists?(name: 'wasalx', version: '202609020014'), package_version: package&.version, package_state: package&.state, attributes: attributes)
    `).split("\n").find((line) => line.startsWith("{")) ?? "");
    assert.equal(blockedState.receipt, false);
    assert.equal(blockedState.package_version, "0.5.84");

    assert.equal(blockedState.package_state, "installed");
    assert.deepEqual(blockedState.attributes, [
      "wasalx_client_routing_version_id", "wasalx_client_id", "wasalx_client_route_status", "wasalx_client_route_matched_by",
    ].map((name) => ({ name, active: true, view_shown: true })));
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package", "bundle", "exec", "rails", "runner",
      `Trigger.find_by!(name: '${migrationGuard}').destroy!`);
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package-predecessor", "bundle", "exec", "rails", "runner", `
      WasalxTicketRoutingJob.perform_later({})
      raise 'Disposable routing job was not queued' unless Delayed::Job.where('handler LIKE ?', '%WasalxTicketRoutingJob%').count == 1
    `);
    const queuedUpgrade = rejectedDocker(directory, project, "run", "--rm", "--no-deps", "zammad-package");
    assert.match(queuedUpgrade, /routing jobs must finish before package transition/u);
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package-predecessor", "bundle", "exec", "rails", "runner",
      `Delayed::Job.where('handler LIKE ?', '%WasalxTicketRoutingJob%').delete_all`);
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package");
    // Qualify the initial sole-group callback before any test creates a second group.
    const soleGroupSource = await readFile(join(process.cwd(), "tests/mailbox-admin-sole-group-native.rb"));
    const soleGroupOutput = await privateNative("run", "--rm", "--no-deps", "--env", "WASALX_TEST_ISOLATED=1", "zammad-package", "bundle", "exec", "rails", "runner",
      `require 'base64'; Module.new.module_eval(Base64.decode64('${soleGroupSource.toString("base64")}'), 'mailbox-admin-sole-group-native.rb')`);
    const soleGroupProof = JSON.parse(soleGroupOutput.split("\n").find(line => line.startsWith('{"mode":"isolated-native-sole-group"')) ?? "");
    assert.deepEqual(soleGroupProof.proof, ["managed-paused-create-and-edit-preserve-nil-sender", "ordinary-native-callback-retained"]);
    await writeFile(join(evidenceDirectory, "portal-native-sole-group-mail.json"), JSON.stringify({ evidenceMode: "simulated", image,
      ...soleGroupProof, testSha256: createHash("sha256").update(soleGroupSource).digest("hex") }, null, 2));
    const assignmentProof = JSON.parse(docker(directory, project, "run", "--rm", "--no-deps", "zammad-package", "bundle", "exec", "rails", "runner", `
      require 'json'
      actor = User.find(1)
      UserInfo.current_user_id = actor.id
      group_a = Group.order(:id).first
      group_b = Group.find_or_create_by!(name: 'WasalX assignment revision proof')
      ticket = Ticket.create!(title: 'Assignment revision rollback proof', group: group_a, customer: actor, created_by: actor, updated_by: actor)
      ticket.update_columns(group_id: group_b.id)
      ticket.update_columns(group_id: group_a.id)
      ticket.reload
      puts JSON.generate(ticket_id: ticket.id, group_a_id: group_a.id, group_b_id: group_b.id, group_id: ticket.group_id, revision: ticket.wasalx_assignment_revision)
    `).split("\n").find((line) => line.startsWith("{")) ?? "");
    assert.equal(assignmentProof.group_id, assignmentProof.group_a_id);
    assert.equal(Number(assignmentProof.revision), 2);
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package-rollback");
    for (const value of [assignmentProof.ticket_id, assignmentProof.group_a_id, assignmentProof.group_b_id]) {
      assert.ok(Number.isSafeInteger(Number(value)) && Number(value) > 0);
    }
    const rollbackAssignmentProof = JSON.parse(docker(directory, project, "exec", "-T", "zammad-postgresql", "psql", "-U", "zammad", "-d", "zammad_production", "-At", "-c", `
      UPDATE tickets SET group_id = ${Number(assignmentProof.group_b_id)} WHERE id = ${Number(assignmentProof.ticket_id)};
      UPDATE tickets SET group_id = ${Number(assignmentProof.group_a_id)} WHERE id = ${Number(assignmentProof.ticket_id)};
      UPDATE tickets SET wasalx_assignment_revision = 0 WHERE id = ${Number(assignmentProof.ticket_id)};
      SELECT json_build_object('group_id', group_id, 'revision', wasalx_assignment_revision)
        FROM tickets WHERE id = ${Number(assignmentProof.ticket_id)};
    `).split("\n").find((line) => line.startsWith("{")) ?? "");
    assert.equal(rollbackAssignmentProof.group_id, assignmentProof.group_a_id);
    assert.equal(Number(rollbackAssignmentProof.revision), 4);
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-package");
    const zammadIdentityProof = () => JSON.parse(docker(
      directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap",
      "bundle", "exec", "rails", "runner", `
        require 'json'
        owner = User.find_by!(email: '${bootstrapEmail}')
        agent = User.find_by!(email: '${agentEmail}')
        operations = Group.find_by!(name: 'Operations')
        group_claims = [agent, owner].map do |actor|
          controller = Api::V1::WasalxController.new
          controller.define_singleton_method(:current_user) { actor }
          panel = Service::Ticket::WasalxPanel.new(ticket: nil, current_user: actor)
          [controller, panel].map { |boundary| boundary.send(:group_actor).fetch(:group_admin) }
        end
        puts JSON.generate(
          owner_id: owner.id, owner_count: User.where(email: '${bootstrapEmail}').count,
          owner_admin: owner.permissions?('admin'), owner_ticket_agent: owner.permissions?('ticket.agent'),
          oidc_bindings: Authorization.where(user_id: owner.id, provider: 'openid_connect').pluck(:provider, :uid, :user_id),
          agent_id: agent.id, agent_count: User.where(email: '${agentEmail}').count,
          agent_roles: agent.roles.pluck(:name).sort, agent_ticket_agent: agent.permissions?('ticket.agent'),
          agent_admin: agent.permissions?('admin'),
          agent_inherited_group_permission: agent.permissions?('ticket.agent.wasalx_groups_admin'),
          group_claims: group_claims,
          agent_admin_grants: agent.permissions.pluck(:name).select { |name| name == 'admin' || name.start_with?('admin.') }.sort,
          agent_group_access: agent.group_ids_access_map,
          agent_effective_groups: agent.group_ids_access(%w[read create change overview]).sort,
          operations_id: operations.id,
          legacy_owner_count: User.where(email: '${legacyBootstrapEmail}').count,
          managed_tokens: ['WasalX Privacy', 'WasalX Service'].map do |name|
            token = Token.find_by!(action: 'api', persistent: true, user_id: owner.id, name: name)
            { id: token.id, name: token.name, user_id: token.user_id,
              count: Token.where(action: 'api', persistent: true, user_id: owner.id, name: name).count }
          end.sort_by { |token| token[:name] }
        )
      `).split("\n").find((line) => line.startsWith("{")) ?? "");
    docker(
      directory, project, "run", "--rm", "--no-deps",
      "-e", `WASALX_ZAMMAD_BOOTSTRAP_EMAIL=${legacyBootstrapEmail}`,
      "-e", "WASALX_ZAMMAD_BOOTSTRAP_NAME=Legacy Compatibility Administrator",
      "-e", `WASALX_ZAMMAD_BOOTSTRAP_PASSWORD=${legacyBootstrapPassword}`,
      "-e", "WASALX_ZAMMAD_BOOTSTRAP_PREVIOUS_EMAIL=",
      "-e", "WASALX_ZAMMAD_AGENT_EMAIL=",
      "-e", "WASALX_ZAMMAD_AGENT_NAME=",
      "-e", "WASALX_ZAMMAD_AGENT_PASSWORD=",
      "zammad-bootstrap",
    );
    const legacyIdentityProof = JSON.parse(docker(
      directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap",
      "bundle", "exec", "rails", "runner", `
        require 'json'
        owner = User.find_by!(email: '${legacyBootstrapEmail}')
        tokens = ['WasalX Privacy', 'WasalX Service'].map do |name|
          token = Token.find_by!(action: 'api', persistent: true, user_id: owner.id, name: name)
          { id: token.id, name: token.name, user_id: token.user_id }
        end.sort_by { |token| token[:name] }
        puts JSON.generate(owner_id: owner.id, current_owner_count: User.where(email: '${bootstrapEmail}').count,
          legacy_owner_count: User.where(email: '${legacyBootstrapEmail}').count, managed_tokens: tokens)
      `).split("\n").find((line) => line.startsWith("{")) ?? "");
    assert.equal(legacyIdentityProof.current_owner_count, 0);
    assert.equal(legacyIdentityProof.legacy_owner_count, 1);
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap");
    const firstIdentityProof = zammadIdentityProof();
    docker(directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap");
    const secondIdentityProof = zammadIdentityProof();
    assert.deepEqual(secondIdentityProof, firstIdentityProof);
    assert.notEqual(firstIdentityProof.owner_id, firstIdentityProof.agent_id);
    groupActorExpectations.set(String(firstIdentityProof.owner_id), true);
    groupActorExpectations.set(String(firstIdentityProof.agent_id), false);
    assert.equal(firstIdentityProof.owner_id, legacyIdentityProof.owner_id);
    assert.deepEqual(
      firstIdentityProof.managed_tokens.map(({ id, name, user_id }) => ({ id, name, user_id })),
      legacyIdentityProof.managed_tokens,
    );
    assert.deepEqual(firstIdentityProof, {
      owner_id: firstIdentityProof.owner_id,
      owner_count: 1,
      owner_admin: true,
      owner_ticket_agent: true,
      oidc_bindings: [["openid_connect", bootstrapSubject, firstIdentityProof.owner_id]],
      agent_id: firstIdentityProof.agent_id,
      agent_count: 1,
      agent_roles: ["Agent"],
      agent_ticket_agent: true,
      agent_admin: false,
      agent_inherited_group_permission: true,
      group_claims: [[false, false], [true, true]],
      agent_admin_grants: [],
      agent_group_access: { [String(firstIdentityProof.operations_id)]: ["full"] },
      agent_effective_groups: [firstIdentityProof.operations_id],
      operations_id: firstIdentityProof.operations_id,
      legacy_owner_count: 0,
      managed_tokens: ["WasalX Privacy", "WasalX Service"].map((name) => {
        const token = firstIdentityProof.managed_tokens.find((candidate) => candidate.name === name);
        return { id: token.id, name, user_id: firstIdentityProof.owner_id, count: 1 };
      }),
    });
    for (const [setup, expected, cleanup] of [
      [
        `Authorization.find_by!(provider: 'openid_connect', uid: '${bootstrapSubject}').update!(user_id: ${firstIdentityProof.agent_id})`,
        "WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT_CONFLICT",
        `Authorization.find_by!(provider: 'openid_connect', uid: '${bootstrapSubject}').update!(user_id: ${firstIdentityProof.owner_id})`,
      ],
      [
        `Authorization.create!(provider: 'openid_connect', uid: 'foreign-subject', user_id: ${firstIdentityProof.owner_id})`,
        "WASALX_ZAMMAD_BOOTSTRAP_OIDC_OWNER_CONFLICT",
        "Authorization.find_by!(provider: 'openid_connect', uid: 'foreign-subject').destroy!",
      ],
    ]) {
      docker(directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap", "bundle", "exec", "rails", "runner",
        `${setup}; User.find(${firstIdentityProof.owner_id}).update!(firstname: 'Conflict sentinel')`);
      try {
        assert.throws(() => docker(directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap"),
          error => `${error.message}\n${error.stderr}\n${error.stdout}`.includes(expected));
        docker(directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap", "bundle", "exec", "rails", "runner",
          `raise 'Rejected bootstrap changed owner' unless User.find(${firstIdentityProof.owner_id}).firstname == 'Conflict sentinel'`);
      } finally {
        docker(directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap", "bundle", "exec", "rails", "runner", cleanup);
      }
      docker(directory, project, "run", "--rm", "--no-deps", "zammad-bootstrap");
      assert.deepEqual(zammadIdentityProof(), firstIdentityProof);
    }
    try {
      docker(directory, project, "up", "--detach", "--wait", "zammad-railsserver", "zammad-websocket", "zammad-nginx");
    } catch (error) {
      process.stderr.write(docker(directory, project, "logs", "--no-color", "zammad-nginx"));
      throw error;
    }

    const membershipIntegration = (await readFile(join(process.cwd(), "tests/zammad-membership-integration.rb"))).toString("base64");
    const membershipIntegrationProof = await dockerAsync(directory, project, "exec", "-T", "zammad-railsserver", "bundle", "exec", "rails", "runner",
      `require 'base64'; eval(Base64.decode64('${membershipIntegration}'), TOPLEVEL_BINDING, 'membership-integration.rb')`);
    assert.match(membershipIntegrationProof, /"explicit_adoption_without_duplicates":true/);
    assert.match(membershipIntegrationProof, /"role_state_sessions_and_native_groups":true/);
    assert.match(membershipIntegrationProof, /"foreign_subject_and_service_admin_protection":true/);
    assert.match(membershipIntegrationProof, /"pending_first_login_without_native_row":true/);
    assert.match(membershipIntegrationProof, /"native_signed_endpoint_fences":true/);

    const legacyIntegration = (await readFile(join(process.cwd(), "tests/zammad-legacy-membership-integration.rb"))).toString("base64");
    const legacyIntegrationProof = await dockerAsync(directory, project, "exec", "-T", "--env", "WASALX_TEST_ISOLATED=1",
      "zammad-railsserver", "bundle", "exec", "rails", "runner",
      `require 'base64'; eval(Base64.decode64('${legacyIntegration}'), TOPLEVEL_BINDING, 'legacy-membership-integration.rb')`);
    for (const assertion of ["native_event_init_destroy_and_core_workflow", "native_timer_queue_and_direct_delivery",
      "caller_owned_active_and_idle_pool_preserved", "revoked_machine_and_current_control_denials"]) {
      assert.ok(legacyIntegrationProof.includes(`"${assertion}":true`), assertion);
    }

    const machineIntegration = (await readFile(join(process.cwd(), "tests/zammad-service-identity-integration.rb"))).toString("base64");
    const machineIntegrationProof = await dockerAsync(directory, project, "exec", "-T", "--env", "WASALX_TEST_ISOLATED=1",
      "zammad-railsserver", "bundle", "exec", "rails", "runner",
      `require 'base64'; eval(Base64.decode64('${machineIntegration}'), TOPLEVEL_BINDING, 'service-identity-integration.rb')`);
    for (const assertion of ["prepared_noninteractive_native_permissions", "atomic_stable_bearer_transfer_and_readback",
      "exact_native_http_scope_and_absence", "reconciliation_current_authority_and_receipt_loss",
      "offline_startup_without_online_transition", "completed_retirement_rechecked", "retained_063_receipt_startup_and_exact_bind"]) {
      assert.ok(machineIntegrationProof.includes(`"${assertion}":true`), assertion);
    }

    const seed = await dockerAsync(directory, project, "exec", "-T", "zammad-railsserver", "bundle", "exec", "rails", "runner", `
      require 'json'
      require 'digest'
      original_fqdn = Setting.get('fqdn')
      begin
        { '127.0.0.1:8081' => '127.0.0.1', 'mail.example.com' => 'mail.example.com', '[::1]:8081' => '[IPv6:::1]' }.each do |authority, expected|
          Setting.set('fqdn', authority)
          ids = 2.times.map do
            candidate = Ticket::Article.new(ticket_id: 1)
            candidate.send(:metadata_email_process_message_id)
            raise 'Generated Message-ID authority is invalid' unless candidate.message_id.end_with?("@#{expected}>")
            raise 'Generated Message-ID digest differs' unless candidate.message_id_md5 == Digest::MD5.hexdigest(candidate.message_id)
            candidate.message_id
          end
          raise 'Generated Message-IDs are not unique' unless ids.uniq.length == 2
        end
      ensure
        Setting.set('fqdn', original_fqdn)
      end
      owner = User.find_by!(login: '${bootstrapEmail}')
      agent = User.find_by!(email: '${agentEmail}')
      owner.update!(password: '${bootstrapPassword}', login_failed: 0)
      Auth.new(owner.login, '${bootstrapPassword}', only_verify_password: true).valid!
      customer = User.find_or_initialize_by(login: 'fixture-0046@example.test')
      customer.update!(firstname: 'Compatibility', lastname: 'Customer', email: 'fixture-0046@example.test', active: true, created_by_id: owner.id, updated_by_id: owner.id)
      group = Group.find_by!(name: 'Operations')
      routing_group = UserInfo.with_user_id(owner.id) { Group.find_or_create_by!(name: 'WasalX routed assignment proof') }
      agent.group_ids_access_map = agent.group_ids_access_map.merge(routing_group.id => 'full')
      agent.save!
      agent.reload
      raise 'Compatibility agent routing access was not persisted' unless agent.group_ids_access_map[routing_group.id] == ['full']
      ticket = Ticket.create!(title: 'Existing shipment SHIP-41', group: group, customer: customer, created_by: customer, updated_by: customer)
      client_routing = { wasalx_client_routing_version_id: '52000000-0000-4000-8000-000000000001', wasalx_client_id: 'compat-client', wasalx_client_route_status: 'MATCHED', wasalx_client_route_matched_by: 'EMAIL' }
      ticket.update!({ wasalx_connection_id: '${connectionId}', wasalx_group_id: '120363118@g.us', wasalx_group_name: 'Riyadh Operations', wasalx_reference: 'SHIP-41', wasalx_provider: 'WAHA', wasalx_correlation_status: 'OPEN', wasalx_delivery_status: 'SENT' }.merge(client_routing))
      ticket.reload
      client_routing_round_trip = client_routing.keys.to_h { |name| [name, ticket.public_send(name)] }
      article = Ticket::Article.create!(ticket: ticket, sender: Ticket::Article::Sender.find_by!(name: 'Customer'), type: Ticket::Article::Type.find_by!(name: 'wasalx group message'), internal: false, content_type: 'text/plain', body: 'Existing shipment SHIP-41', message_id: '${existingMessageId}', preferences: { 'wasalx_origin' => 'provider', 'wasalx_external_message_id' => '${existingMessageId}' }, created_by: customer, updated_by: customer)
      routing_ticket = Ticket.create!(title: 'Native email routing proof', group: group, customer: customer, created_by: customer, updated_by: customer)
      routing_attributes = { ticket: routing_ticket, sender: Ticket::Article::Sender.find_by!(name: 'Customer'),
        type: Ticket::Article::Type.find_by!(name: 'email'), internal: false, content_type: 'text/plain',
        subject: 'Native email routing proof', body: 'Route this email', from: 'Client <route-proof@example.invalid>',
        to: 'support@example.invalid', created_by: customer, updated_by: customer }
      routing_jobs = Delayed::Job.where('handler LIKE ?', '%WasalxTicketRoutingJob%')
      routing_jobs_before = routing_jobs.count
      postmaster_article = nil
      postmaster_context_preserved = false
      postmaster_article_visible_in_transaction = false
      postmaster_routing_jobs_in_transaction = 0
      ActiveRecord::Base.transaction(requires_new: true) do
        Transaction.execute({ interface_handle: 'application_server.postmaster' }) do
          postmaster_article = Ticket::Article.new(**routing_attributes)
          postmaster_article.application_handle_info_postmaster = false
          postmaster_article.save!
          postmaster_context_preserved = postmaster_article.application_handle_info_postmaster == true
          postmaster_article_visible_in_transaction = Ticket::Article.exists?(postmaster_article.id)
          postmaster_routing_jobs_in_transaction = routing_jobs.count - routing_jobs_before
        end
        raise ActiveRecord::Rollback
      end
      postmaster_article_rolled_back = !Ticket::Article.exists?(postmaster_article.id)
      postmaster_routing_jobs_rolled_back = routing_jobs.count == routing_jobs_before
      postmaster_pending_marker_rolled_back = routing_ticket.reload.wasalx_client_route_status.nil?
      committed_article = nil
      Transaction.execute({ interface_handle: 'application_server.postmaster' }) do
        committed_article = Ticket::Article.new(**routing_attributes.merge(subject: 'Committed postmaster proof'))
        committed_article.application_handle_info_postmaster = false
        committed_article.save!
      end
      committed_context_preserved = committed_article.application_handle_info_postmaster == true
      committed_article_id = committed_article.id
      committed_article.reload
      committed_pending_status = routing_ticket.reload.wasalx_client_route_status
      later_committed_article = nil
      Transaction.execute({ interface_handle: 'application_server.postmaster' }) do
        later_committed_article = Ticket::Article.create!(**routing_attributes.merge(subject: 'Later committed postmaster proof'))
      end
      committed_job = routing_jobs.order(:id).last
      committed_job_data = committed_job&.payload_object&.instance_variable_get(:@job_data) || {}
      committed_job_arguments = Array(committed_job_data['arguments']).first || {}
      committed_routing_jobs = routing_jobs.count - routing_jobs_before
      committed_job_class = committed_job_data['job_class']
      committed_job_article_id = committed_job_arguments['article_id']
      committed_job_assignment_revision = committed_job_arguments['expected_assignment_revision']
      routing_acknowledgement = nil
      routing_acknowledgement_calls = 0
      routing_history_before = History.where(o_id: routing_ticket.id).count
      delivery_history_before = nil
      delivery_article = nil
      delivery_calls = 0
      original_wasalx_post = Wasalx::Client.method(:post)
      Wasalx::Client.define_singleton_method(:post) do |path, payload, scope:, actor: nil|
        case path
        when '/internal/v1/zammad/routing'
          raise 'Unexpected routing scope' unless scope == 'zammad:routing'
          {
            'route_id' => '51000000-0000-4000-8000-000000000001',
            'ticket_id' => payload.fetch(:ticket_id).to_s,
            'source_article_id' => payload.fetch(:article_id).to_s,
            'routed' => true, 'status' => 'MATCHED',
            'routing_version_id' => '52000000-0000-4000-8000-000000000002',
            'client_id' => 'compat-routing-client', 'matched_by' => 'EMAIL',
            'zammad_group_id' => routing_group.id.to_s, 'owner_id' => agent.id.to_s
          }
        when '/internal/v1/zammad/routing/acknowledgement'
          raise 'Unexpected routing acknowledgement scope' unless scope == 'zammad:routing'
          routing_acknowledgement_calls += 1
          routing_acknowledgement = payload
          {
            'route_id' => payload.fetch(:route_id), 'acknowledged' => true,
            'application_status' => payload.fetch(:application_status),
            'observed_group_id' => payload.fetch(:observed_group_id),
            'observed_owner_id' => payload[:observed_owner_id], 'duplicate' => false
          }
        when '/internal/v1/zammad/outbound'
          raise 'Unexpected delivery scope' unless scope == 'zammad:outbound' && actor
          delivery_calls += 1
          { 'id' => '71000000-0000-4000-8000-000000000001', 'state' => 'QUEUED' }
        else
          raise "Unexpected WasalX request: #{path}"
        end
      end
      begin
        committed_job.payload_object.perform
        acknowledgement_job = routing_jobs.order(:id).last
        acknowledgement_job_data = acknowledgement_job&.payload_object&.instance_variable_get(:@job_data) || {}
        acknowledgement_job_arguments = Array(acknowledgement_job_data['arguments']).first || {}
        committed_job.destroy!
        raise 'Routing decision did not enqueue its acknowledgement phase' unless acknowledgement_job_arguments['phase'] == 'ACKNOWLEDGEMENT'
        acknowledgement_job.payload_object.perform
        acknowledgement_job.destroy!
        routing_jobs_after_success = routing_jobs.count - routing_jobs_before
        routing_ticket.reload
        routing_history_after = History.where(o_id: routing_ticket.id).count
        routing_event_buffer_empty = EventBuffer.list('transaction').empty?

        preflight_query = URI.encode_www_form(connection_id: ticket.wasalx_connection_id, group_id: ticket.wasalx_group_id, ticket_id: ticket.id)
        outbound_preflight = Wasalx::Client.get(
          "/internal/v1/zammad/outbound/preflight?#{preflight_query}", scope: 'zammad:outbound',
          actor: { user_id: owner.id, group_ids: owner.group_ids_access('read'), group_admin: owner.permissions?('admin') }
        )
        raise 'WasalX outbound preflight was unavailable' unless outbound_preflight['available'] == true
        original_wasalx_get = Wasalx::Client.method(:get)
        articles_before_denial = Ticket::Article.where(ticket_id: ticket.id).count
        jobs_before_denial = Delayed::Job.count
        begin
          Wasalx::Client.define_singleton_method(:get) do |*args, **kwargs|
            raise Wasalx::Client::PermanentRequestFailed, 'private upstream detail must not escape'
          end
          denied = Ticket::Article.new(
            ticket: ticket, sender: Ticket::Article::Sender.find_by!(name: 'Agent'),
            type: Ticket::Article::Type.find_by!(name: 'wasalx group message'), internal: false,
            content_type: 'text/plain', body: 'Denied public reply', created_by: owner, updated_by: owner
          )
          begin
            denied.save!
            raise 'Denied public reply unexpectedly persisted'
          rescue ActiveRecord::RecordInvalid => error
            raise 'Native validation lost the actionable error' unless error.record.errors[:base] == ['WhatsApp access or availability could not be verified. Refresh the ticket and try again.']
          end
          raise 'Denied public reply created an article or job' unless Ticket::Article.where(ticket_id: ticket.id).count == articles_before_denial && Delayed::Job.count == jobs_before_denial
        ensure
          Wasalx::Client.define_singleton_method(:get, original_wasalx_get)
        end
        delivery_article = Ticket::Article.create!(
          ticket: ticket, sender: Ticket::Article::Sender.find_by!(name: 'Agent'),
          type: Ticket::Article::Type.find_by!(name: 'wasalx group message'), internal: false,
          content_type: 'text/plain', body: 'Operator delivery dispatcher proof',
          created_by: owner, updated_by: owner
        )
        delivery_history_before = History.where(o_id: [ticket.id, delivery_article.id]).count
        Service::Ticket::Article::Type::WasalxGroupMessage::Deliver.execute(article_id: delivery_article.id)
        delivery_article.reload
        ticket.reload
        delivery_history_after = History.where(o_id: [ticket.id, delivery_article.id]).count
        delivery_event_buffer_empty = EventBuffer.list('transaction').empty?
      ensure
        Wasalx::Client.define_singleton_method(:post, original_wasalx_post)
      end
      outside_article = Ticket::Article.new(**routing_attributes.merge(subject: 'Outside postmaster proof'))
      outside_article.application_handle_info_postmaster = true
      outside_article.save!
      outside_context_overridden = outside_article.application_handle_info_postmaster == false
      outside_routing_jobs = routing_jobs.count - routing_jobs_before
      closed_ticket = Ticket.create!(title: 'Resolved shipment SHIP-40', group: group, customer: customer, state: Ticket::State.by_category(:closed).first, created_by: customer, updated_by: customer)
      closed_article = Ticket::Article.create!(ticket: closed_ticket, sender: Ticket::Article::Sender.find_by!(name: 'Customer'), type: Ticket::Article::Type.find_by!(name: 'note'), internal: false, content_type: 'text/plain', body: 'Resolved shipment SHIP-40', created_by: customer, updated_by: customer)
      staged = Store.create!(object: 'Wasalx::GroupWorkspaceUpload', o_id: '${stagedUploadId}', filename: 'stage-proof.txt', data: 'stage-data', preferences: { 'Content-Type' => 'text/plain' }, created_by_id: owner.id)
      staged.update_columns(created_at: 8.days.ago, updated_at: Time.current)
      stale = Store.create!(object: 'Wasalx::GroupWorkspaceUpload', o_id: '${staleUploadId}', filename: 'stale-proof.txt', data: 'stale-data', preferences: { 'Content-Type' => 'text/plain' }, created_by_id: owner.id)
      stale.update_columns(created_at: 8.days.ago, updated_at: 8.days.ago)
      restricted = Token.find_or_initialize_by(action: 'api', persistent: true, user_id: owner.id, name: 'WasalX Restricted Compatibility')
      restricted.preferences = { permission: ['ticket.agent'] }
      restricted.expires_at = nil
      restricted.save!
      restricted.update_columns(token: '${restrictedToken}', updated_at: Time.current)
      WasalxGroupWorkspaceUploadCleanupJob.perform_now
      service = Token.find_by!(action: 'api', token: '${serviceToken}')
      service_permissions = Array(service.preferences[:permission] || service.preferences['permission'])
      scheduler = Scheduler.find_by(method: 'WasalxGroupWorkspaceUploadCleanupJob.perform_now')
      ${nativeCloseScenario}
      native_close = native_close_proof.call(owner: owner, customer: customer, group: group, service_token: '${serviceToken}', namespace: 'wasalx-native-close-compat')
      native_direct = native_direct_keep_open_proof.call(owner: owner, customer: customer, group: group, namespace: 'wasalx-native-direct-compat')
      native_denied = native_denied_command_proof.call(owner: owner, customer: customer, group: group, service_token: '${serviceToken}', namespace: 'wasalx-native-denied-compat')
      # The dispatcher Agent article correctly moved this fixture to OPEN.
      # Prepare NEW through the fixture model, not the edit API (which rejects NEW).
      fixture_article_ids = Ticket::Article.where(ticket_id: ticket.id).order(:id).pluck(:id)
      fixture_job_ids = Delayed::Job.order(:id).pluck(:id)
      ticket.reload.update!(state: Ticket::State.find_by!(name: 'new'))
      raise 'Native browser fixture NEW preparation failed' unless ticket.reload.state.name == 'new'
      raise 'Native browser fixture preparation changed articles' unless Ticket::Article.where(ticket_id: ticket.id).order(:id).pluck(:id) == fixture_article_ids
      raise 'Native browser fixture preparation removed jobs' unless fixture_job_ids.all? { |id| Delayed::Job.exists?(id) }
      puts JSON.generate(native_denied: native_denied, native_direct: native_direct, native_close: native_close, reply_fixture_state: ticket.state.name, customer_id: customer.id.to_s, ticket_id: ticket.id.to_s, ticket_number: ticket.number.to_s, article_id: article.id.to_s, closed_ticket_id: closed_ticket.id.to_s, closed_ticket_number: closed_ticket.number.to_s, closed_article_id: closed_article.id.to_s, staged_store_id: staged.id.to_s, staged_present: Store.exists?(staged.id), stale_present: Store.exists?(stale.id), service_permissions: service_permissions, cleanup_scheduler_active: scheduler&.active == true, fqdn: Setting.get('fqdn'), http_type: Setting.get('http_type'), client_routing_round_trip: client_routing_round_trip, queue_adapter: ActiveJob::Base.queue_adapter.class.name, postmaster_context_preserved: postmaster_context_preserved, postmaster_article_visible_in_transaction: postmaster_article_visible_in_transaction, postmaster_routing_jobs_in_transaction: postmaster_routing_jobs_in_transaction, postmaster_article_rolled_back: postmaster_article_rolled_back, postmaster_routing_jobs_rolled_back: postmaster_routing_jobs_rolled_back, postmaster_pending_marker_rolled_back: postmaster_pending_marker_rolled_back, committed_context_preserved: committed_context_preserved, committed_article_id: committed_article_id, committed_article_persisted: committed_article.persisted?, later_committed_article_id: later_committed_article.id, committed_pending_status: committed_pending_status, committed_routing_jobs: committed_routing_jobs, committed_job_class: committed_job_class, committed_job_article_id: committed_job_article_id, committed_job_assignment_revision: committed_job_assignment_revision, acknowledgement_job_class: acknowledgement_job_data['job_class'], acknowledgement_job_phase: acknowledgement_job_arguments['phase'], acknowledgement_job_article_id: acknowledgement_job_arguments['article_id'], routing_status: routing_ticket.wasalx_client_route_status, routing_group_id: routing_ticket.group_id.to_s, routing_target_group_id: routing_group.id.to_s, routing_target_owner_id: agent.id.to_s, routing_owner_id: routing_ticket.owner_id.to_i.positive? ? routing_ticket.owner_id.to_s : nil, routing_assignment_revision: routing_ticket.wasalx_assignment_revision, routing_acknowledgement: routing_acknowledgement, routing_acknowledgement_calls: routing_acknowledgement_calls, routing_jobs_after_success: routing_jobs_after_success, routing_history_delta: routing_history_after - routing_history_before, routing_event_buffer_empty: routing_event_buffer_empty, delivery_article_id: delivery_article.id.to_s, delivery_state: delivery_article.preferences['wasalx_delivery_state'], delivery_ticket_state: ticket.wasalx_delivery_status, delivery_calls: delivery_calls, delivery_history_delta: delivery_history_after - delivery_history_before, delivery_event_buffer_empty: delivery_event_buffer_empty, outside_context_overridden: outside_context_overridden, outside_routing_jobs: outside_routing_jobs)
    `);
    const seeded = JSON.parse(seed.split("\n").find((line) => line.startsWith("{")) ?? "");
    assert.equal(seeded.reply_fixture_state, "new");
    assert.equal(seeded.native_close.mode, "actual-native-rails-simulated-client");
    assert.deepEqual(seeded.native_close.orders.map(row => row.order), ["close-first", "reply-first"]);
    assert.equal(seeded.native_close.imported_exclusion, true);
    assert.equal(seeded.native_close.forged_marker_rejected, true);
    assert.equal(seeded.native_close.same_save_rollback, true);
    assert.equal(seeded.native_close.historical_jobs_preserved, true);
    for (const key of ["standaloneReplyLock", "articleRollback", "durableIntentObservation", "customerCloseReceipt", "customerCallbackReceipt", "unknownReceiptNoReplay"]) assert.equal(seeded.native_direct[key], true);
    assert.equal(seeded.native_denied.mode, "actual-native-rails-simulated-client");
    assert.deepEqual(seeded.native_denied.states, ["new", "open", "closed"]);
    for (const key of ["stateOwnershipPreserved", "duplicateReceipt", "unknownReadOnly", "noCommunicationOrStateCallbacks", "historicalJobsPreserved"]) assert.equal(seeded.native_denied[key], true);
    assert.equal(seeded.native_denied.providerActions, 0);
    Object.assign(state, { customerId: seeded.customer_id, ticketId: seeded.ticket_id, ticketNumber: seeded.ticket_number, articleId: seeded.article_id, closedTicketId: seeded.closed_ticket_id, closedTicketNumber: seeded.closed_ticket_number, closedArticleId: seeded.closed_article_id });
    const outboundPreflight = state.requests.find((request) => request.path === "/internal/v1/zammad/outbound/preflight");
    assert.ok(outboundPreflight);
    assert.equal(new URLSearchParams(outboundPreflight.query).get("ticket_id"), seeded.ticket_id);
    assert.equal(seeded.staged_present, true);
    assert.equal(seeded.stale_present, false);
    assert.equal(seeded.cleanup_scheduler_active, true);
    assert.equal(seeded.fqdn, runnerContainer ? "zammad-nginx:8080" : `127.0.0.1:${port}`);
    assert.equal(seeded.http_type, "http");
    assert.deepEqual(seeded.client_routing_round_trip, {
      wasalx_client_routing_version_id: "52000000-0000-4000-8000-000000000001",
      wasalx_client_id: "compat-client",
      wasalx_client_route_status: "MATCHED",
      wasalx_client_route_matched_by: "EMAIL",
    });
    assert.equal(seeded.postmaster_context_preserved, true);
    assert.equal(seeded.queue_adapter, "ActiveJob::QueueAdapters::DelayedJobAdapter");
    assert.equal(seeded.postmaster_article_visible_in_transaction, true);
    assert.equal(seeded.postmaster_routing_jobs_in_transaction, 1);
    assert.equal(seeded.postmaster_article_rolled_back, true);
    assert.equal(seeded.postmaster_routing_jobs_rolled_back, true);
    assert.equal(seeded.postmaster_pending_marker_rolled_back, true);
    assert.equal(seeded.committed_context_preserved, true);
    assert.equal(seeded.committed_article_persisted, true);
    assert.equal(seeded.committed_routing_jobs, 1);
    assert.equal(seeded.committed_pending_status, "PENDING");
    assert.equal(seeded.committed_job_class, "WasalxTicketRoutingJob");
    assert.equal(String(seeded.committed_job_article_id), String(seeded.committed_article_id));
    assert.equal(Number(seeded.committed_job_assignment_revision), 0);
    assert.equal(seeded.acknowledgement_job_class, "WasalxTicketRoutingJob");
    assert.equal(seeded.acknowledgement_job_phase, "ACKNOWLEDGEMENT");
    assert.equal(String(seeded.acknowledgement_job_article_id), String(seeded.committed_article_id));
    assert.equal(seeded.routing_status, "MATCHED");
    assert.equal(seeded.routing_group_id, seeded.routing_target_group_id);
    assert.equal(seeded.routing_owner_id, seeded.routing_target_owner_id);
    assert.equal(Number(seeded.routing_assignment_revision), 1);
    assert.equal(seeded.routing_acknowledgement.application_status, "APPLIED");
    assert.equal(String(seeded.routing_acknowledgement.observed_group_id), String(seeded.routing_group_id));
    assert.equal(seeded.routing_acknowledgement.observed_owner_id, seeded.routing_owner_id);
    assert.equal(seeded.routing_acknowledgement_calls, 1);
    assert.equal(seeded.routing_jobs_after_success, 0);
    assert.ok(seeded.routing_history_delta > 0);
    assert.equal(seeded.routing_event_buffer_empty, true);
    assert.equal(seeded.delivery_state, "QUEUED");
    assert.equal(seeded.delivery_ticket_state, "QUEUED");
    assert.equal(seeded.delivery_calls, 1);
    assert.ok(seeded.delivery_history_delta > 0);
    assert.equal(seeded.delivery_event_buffer_empty, true);
    assert.equal(seeded.outside_context_overridden, true);
    assert.equal(seeded.outside_routing_jobs, 0);
    assert.ok(seeded.service_permissions.includes("admin.system"));
    assert.ok(!seeded.service_permissions.includes("admin"));
    const zammadOrigin = runnerContainer ? "http://zammad-nginx:8080" : `http://127.0.0.1:${port}`;
    const stagedUrl = `${zammadOrigin}/api/v1/wasalx/group_workspace/uploads/${stagedUploadId}/${seeded.staged_store_id}`;
    const serviceHeaders = { Authorization: `Token token=${serviceToken}` };
    const restrictedResponse = await fetch(stagedUrl, { headers: { Authorization: `Token token=${restrictedToken}` } });
    assert.equal(restrictedResponse.status, 403);
    const stagedResponse = await fetch(stagedUrl, { headers: serviceHeaders });
    assert.equal(stagedResponse.status, 200);
    assert.equal(await stagedResponse.text(), "stage-data");
    assert.match(stagedResponse.headers.get("content-type") ?? "", /^text\/plain/u);
    assert.match(stagedResponse.headers.get("content-disposition") ?? "", /stage-proof\.txt/u);
    const stagedDeleteResponse = await fetch(stagedUrl, { method: "DELETE", headers: serviceHeaders });
    assert.equal(stagedDeleteResponse.status, 204);
    const deletedStage = docker(directory, project, "exec", "-T", "zammad-railsserver", "bundle", "exec", "rails", "runner",
      `require 'json'; puts JSON.generate(present: Store.exists?(${JSON.stringify(seeded.staged_store_id)}))`);
    assert.equal(JSON.parse(deletedStage.split("\n").find((line) => line.startsWith("{")) ?? "").present, false);
    state.links.push({ messageId: existingMessageId, ticketId: seeded.ticket_id, articleId: seeded.article_id });
    state.links.push({ messageId: closedMessageId, ticketId: seeded.closed_ticket_id, articleId: seeded.closed_article_id });

    browser = await chromium.launch({ headless: true });
    const signIn = async (page, username, loginPassword) => {
      await page.goto(`${zammadOrigin}/desktop/login`, { waitUntil: "domcontentloaded" });
      assert.equal(await page.getByRole("link", { name: "Register" }).count(), 0);
      await page.getByLabel("Username / Email").fill(username);
      await page.getByLabel("Password").fill(loginPassword);
      await page.getByRole("button", { name: "Sign in" }).click();
      const betaDisclaimer = page.getByRole("dialog", { name: "New desktop BETA UI" });
      await betaDisclaimer.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
      if (await betaDisclaimer.isVisible()) await betaDisclaimer.getByRole("button", { name: "Confirm" }).click();
    };
    const setNativeLocale = async (login, locale) => {
      assert.ok([bootstrapEmail, agentEmail].includes(login));
      assert.ok(["en-us", "ar"].includes(locale));
      const result = JSON.parse((await dockerAsync(directory, project, "exec", "-T", "zammad-railsserver", "bundle", "exec", "rails", "runner", `
        require 'json'; Locale.find_by!(locale: '${locale}', active: true)
        user=User.find_by!(login: '${login}'); user.preferences['locale']='${locale}'; user.save!
        puts JSON.generate(locale:user.reload.preferences['locale'])
      `)).split("\n").find(line => line.startsWith("{")) ?? "");
      assert.equal(result.locale, locale);
    };
    const scenarios = [
      { name: "en-desktop", locale: "en-us", mobile: false, viewport: { width: 1440, height: 1000 } },
      { name: "en-mobile", locale: "en-us", mobile: true, viewport: { width: 390, height: 844 } },
      { name: "ar-desktop", locale: "ar", mobile: false, viewport: { width: 1440, height: 1000 } },
      { name: "ar-mobile", locale: "ar", mobile: true, viewport: { width: 390, height: 844 } },
    ];
    await setNativeLocale(bootstrapEmail, "en-us");
    const adminSession = await browser.newContext({ viewport: scenarios[0].viewport, timezoneId: "Asia/Riyadh" });
    const adminSessionPage = await adminSession.newPage();
    await signIn(adminSessionPage, bootstrapEmail, bootstrapPassword);
    await adminSessionPage.getByRole("button", { name: "Administration" }).waitFor();
    const missingGroup = await adminSessionPage.evaluate(async () => {
      const response = await fetch("/api/v1/wasalx/group_workspace/groups/00000000-0000-4000-8000-000000000000/messages?limit=50");
      return { status: response.status, body: await response.json() };
    });
    assert.deepEqual(missingGroup, { status: 404, body: { error: "Not found" } });
    const adminStorageState = await adminSession.storageState();
    await adminSession.close();
    const proveNativeQueueGrant = async (scenario) => {
      await setNativeLocale(bootstrapEmail, scenario.locale);
      // Isolated native UI fixture, with machine roles and blank immutable email.
      // Start without grants and add the queue through the real Users form.
      const machineUiSeed = JSON.parse((await dockerAsync(directory, project, "exec", "-T", "zammad-railsserver", "bundle", "exec", "rails", "runner", `
        require 'json'; owner=User.find_by!(login: '${bootstrapEmail}'); UserInfo.current_user_id=owner.id
        roles=%w[wasalx_service wasalx_privacy].map do |name|
          role=Role.find_or_create_by!(name: "UI proof #{name}") { |r| r.active=true; r.default_at_signup=false; r.created_by_id=owner.id; r.updated_by_id=owner.id }
          role.permissions=[Permission.find_by!(name: name)]; role
        end
        group=Group.find_by!(name: 'Operations')
        machine=User.create!(login: "tenant-automation-ui-#{SecureRandom.hex(12)}", email: '', firstname: 'Tenant', lastname: 'Automation UI proof', active: true,
          roles: [Role.find_by!(name: 'Agent'), *roles], created_by_id: owner.id, updated_by_id: owner.id)
        raise 'UI fixture inherited queue access' unless machine.group_ids_access_map.empty?
        puts JSON.generate(id:machine.id,login:machine.login,group_id:group.id,role_ids:machine.role_ids.sort)
      `)).split("\n").find(line => line.startsWith("{")) ?? "");
      const adminContext = await browser.newContext({ viewport: scenario.viewport, timezoneId: "Asia/Riyadh",
        isMobile: scenario.mobile, hasTouch: scenario.mobile, storageState: adminStorageState });
      const adminPage = await adminContext.newPage();
      const coreWorkflowRequests = new Set();
      const coreWorkflowResponses = new Set();
      let coreWorkflowCompleted;
      adminPage.on('websocket', socket => {
        socket.on('framesent', frame => {
          let value;
          try { value = JSON.parse(frame.payload.toString()); } catch { return; }
          if (value.event === 'core_workflow' && String(value.params?.id) === String(machineUiSeed.id)
            && value.params?.group_ids?.[String(machineUiSeed.group_id)]?.includes('full')) {
            coreWorkflowRequests.add(value.request_id);
          }
        });
        socket.on('framereceived', frame => {
          let values;
          try { values = JSON.parse(frame.payload.toString()); } catch { return; }
          for (const value of Array.isArray(values) ? values : [values]) {
            if (value.event === 'core_workflow' && coreWorkflowRequests.has(value.data?.request_id)) {
              coreWorkflowResponses.add(value.data.request_id);
              coreWorkflowCompleted?.();
            }
          }
        });
      });
      let saveAttempted = false;
      try {
      await adminPage.goto(`${zammadOrigin}/#manage/users`, { waitUntil: "domcontentloaded", referer: `${zammadOrigin}/desktop` });
      await adminPage.waitForFunction(locale => window.App?.i18n?.get() === locale
        && window.App?.Session?.get('preferences')?.locale === locale, scenario.locale);
      const language = await adminPage.evaluate(() => ({ locale: window.App.i18n.get(), dir: document.documentElement.dir,
        search: window.App.i18n.translatePlain("Search for users"), submit: window.App.i18n.translatePlain("Submit") }));
      assert.equal(language.dir, scenario.locale === "ar" ? "rtl" : "ltr");
      if (scenario.locale === "ar") { assert.notEqual(language.search, "Search for users"); assert.notEqual(language.submit, "Submit"); }
      await adminPage.getByPlaceholder(language.search).fill(machineUiSeed.login);
      await adminPage.locator(`tr[data-id="${machineUiSeed.id}"]`).click();
      const machineDialog = adminPage.locator('.modal:visible');
      const fullGrant = machineDialog.locator(`input[name="group_ids::${machineUiSeed.group_id}"][value="full"]`);
      assert.equal(await fullGrant.count(), 0);
      const newGrant = machineDialog.locator('.js-groupListNewItemRow');
      await newGrant.locator('.js-groupListItemAddNew .js-input').click();
      await newGrant.getByRole('option', { name: 'Operations', exact: true }).click();
      await newGrant.locator('input[value="full"]').locator('..').click();
      await newGrant.locator('.js-add').click();
      assert.equal(await fullGrant.isChecked(), true);
      await new Promise((resolve, reject) => {
        if (coreWorkflowResponses.size) return resolve();
        const timeout = setTimeout(() => reject(new Error('No matching Users Full-grant CoreWorkflow websocket response')), 30_000);
        coreWorkflowCompleted = () => { clearTimeout(timeout); resolve(); };
      });
      await adminPage.waitForFunction(() => window.App?.WebSocket?.channel()
        && !window.App.Config.get('core_workflow_ajax_mode')
        && Object.keys(window.App.FormHandlerCoreWorkflow.getRequests()).length === 0);
      const machineSave = adminPage.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/users/${machineUiSeed.id}`
        && ['PUT', 'PATCH'].includes(response.request().method()), { timeout: 30_000 });
      await adminPage.screenshot({ path: join(evidenceDirectory, `native-permission-${scenario.name}-before.png`), fullPage: false });
      saveAttempted = true;
      await machineDialog.getByRole('button', { name: language.submit, exact: true }).click();
      assert.equal((await machineSave).status(), 200);
      await machineDialog.waitFor({ state: 'hidden' });
      await adminPage.reload({ waitUntil: "domcontentloaded" });
      await adminPage.waitForFunction(locale => window.App?.i18n?.get() === locale
        && window.App?.Session?.get('preferences')?.locale === locale, scenario.locale);
      await adminPage.getByPlaceholder(language.search).fill(machineUiSeed.login);
      await adminPage.locator(`tr[data-id="${machineUiSeed.id}"]`).click();
      assert.equal(await fullGrant.isChecked(), true);
      await adminPage.screenshot({ path: join(evidenceDirectory, `native-permission-${scenario.name}-after.png`), fullPage: false });
      const legacyGrantUiProof = JSON.parse((await dockerAsync(directory, project, "exec", "-T", "zammad-railsserver", "bundle", "exec", "rails", "runner", `
        require 'json'; user=User.find(${machineUiSeed.id}); puts JSON.generate(id:user.id,email:user.email,roles:user.role_ids.sort,
          grants:user.group_ids_access_map,admin:user.permissions?('admin'),password:user.password.present?,authorizations:Authorization.where(user_id:user.id).count)
        user.destroy!
      `)).split("\n").find(line => line.startsWith("{")) ?? "");
      assert.deepEqual(legacyGrantUiProof, { id: machineUiSeed.id, email: '', roles: machineUiSeed.role_ids,
        grants: { [String(machineUiSeed.group_id)]: ['full'] }, admin: false, password: false, authorizations: 0 });
      const proof = { ...scenario, coreWorkflowTransport: "websocket", matchingRequestResponseIds: [...coreWorkflowResponses],
        initiallyEmpty: true, addedFullThroughUi: true, saveAndReload: true, canonical: legacyGrantUiProof };
      await writeFile(join(evidenceDirectory, `native-permission-${scenario.name}.json`), JSON.stringify(proof, null, 2));
      return proof;
      } catch (error) {
        await writeFile(join(evidenceDirectory, `native-permission-${scenario.name}-failure.json`), JSON.stringify({
          ...scenario, machineId: machineUiSeed.id, saveAttempted, noReplay: true, error: String(error),
          matchingRequestResponseIds: [...coreWorkflowResponses],
        }, null, 2));
        throw error;
      } finally { await adminContext.close(); }

    };
    const legacyGrantUiProofs = [await proveNativeQueueGrant(scenarios[0])];

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Riyadh" });
    const page = await context.newPage();
    const entryResponse = await fetch(`${zammadOrigin}/?from=wasalx`, { redirect: "manual" });
    assert.equal(entryResponse.status, 302);
    const entryLocation = new URL(entryResponse.headers.get("location") ?? "", entryResponse.url);
    assert.equal(entryLocation.origin, new URL(entryResponse.url).origin);
    assert.equal(`${entryLocation.pathname}${entryLocation.search}`, "/desktop?from=wasalx");
    const legacyEntryResponse = await fetch(`${zammadOrigin}/`, {
      headers: { referer: `${zammadOrigin}/desktop/tickets/view` },
      redirect: "manual",
    });
    assert.equal(legacyEntryResponse.status, 200);
    await page.goto(`${zammadOrigin}/`, { waitUntil: "domcontentloaded" });
    assert.equal(new URL(page.url()).pathname.startsWith("/desktop"), true);
    await signIn(page, agentEmail, agentPassword);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${globalThis.location.host}/cable`);
      const timeout = globalThis.setTimeout(() => { socket.close(); reject(new Error("ActionCable connection timed out")); }, 10_000);
      socket.addEventListener("open", () => { globalThis.clearTimeout(timeout); socket.close(); resolve(undefined); }, { once: true });
      socket.addEventListener("error", () => { globalThis.clearTimeout(timeout); reject(new Error("ActionCable connection failed")); }, { once: true });
    }));
    await page.goto(`${zammadOrigin}/desktop`, { waitUntil: "domcontentloaded" });
    const workspaceLink = page.locator('a[href*="/wasalx/groups"]').first();
    await workspaceLink.waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await page.getByRole("button", { name: "Administration" }).count(), 0);
    assert.match(await workspaceLink.getAttribute("href") ?? "", /^\/desktop\/wasalx\/groups(?:[?#]|$)/u);
    await workspaceLink.click();
    await page.waitForURL((url) => url.pathname === "/desktop/wasalx/groups");
    await page.getByRole("heading", { name: "WhatsApp Groups" }).waitFor();
    await page.getByText("Riyadh Operations", { exact: true }).first().click();
    const existingMessage = page.locator(`[data-message-id="${existingMessageId}"]`);
    await existingMessage.getByText("Existing shipment SHIP-41", { exact: true }).waitFor();
    const skipToComposer = page.getByRole("link", { name: "Skip to message composer" });
    await skipToComposer.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "wasalx-group-message");

    await page.getByRole("button", { name: /^Show linked message/u }).click();
    await page.waitForFunction((messageId) => document.activeElement?.dataset.messageId === messageId, existingMessageId);

    await existingMessage.getByRole("button", { name: "Quote" }).click();
    await page.getByPlaceholder("Write a group message").fill("Checking SHIP-41 now.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#wasalx-group-message")?.value === "");
    const sentMessage = page.locator('[data-message-id="14000000-0000-4000-8000-000000000001"]');
    await sentMessage.getByText("Checking SHIP-41 now.", { exact: true }).waitFor();
    await sentMessage.getByText("Queued", { exact: true }).waitFor();
    assert.ok(state.requests.some((request) => request.path.endsWith("/send") && request.body?.replyToMessageId === existingMessageId));

    await page.getByPlaceholder("Write a group message").fill("@Cus");
    let mentionOption = page.getByRole("option", { name: /Customer One/u });
    await mentionOption.waitFor();
    assert.equal(await mentionOption.getAttribute("tabindex"), "-1");
    await page.keyboard.press("Tab");
    await mentionOption.waitFor({ state: "hidden" });
    await page.getByPlaceholder("Write a group message").fill("@Cus");
    mentionOption = page.getByRole("option", { name: /Customer One/u });
    await mentionOption.waitFor();
    await mentionOption.click();
    await page.getByPlaceholder("Write a group message").fill("@12025550102 please review");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#wasalx-group-message")?.value === "");
    assert.deepEqual(state.requests.filter((request) => request.path.endsWith("/send")).at(-1)?.body?.mentions, ["12025550102@lid"]);

    const fileInput = page.locator('input[type="file"][multiple]');
    await page.getByRole("button", { name: "Attach files" }).waitFor();
    const uploadResponsePromise = page.waitForResponse((response) => response.url().includes("/api/v1/upload_caches/") && response.request().method() === "POST");
    await fileInput.setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlU4XcAAAAASUVORK5CYII=", "base64") });
    const uploadResponse = await uploadResponsePromise;
    const uploadPayload = await uploadResponse.json();
    assert.equal(uploadResponse.status(), 200, JSON.stringify(uploadPayload));
    await page.getByText("proof.png").first().waitFor();
    const uploadUi = await page.evaluate(() => ({
      error: document.querySelector("#wasalx-group-message-error")?.textContent?.trim() || null,
      visible: document.body.innerText.includes("proof.png"),
    }));
    assert.equal(uploadUi.error, null, JSON.stringify({ uploadPayload, uploadUi }));
    assert.equal(uploadUi.visible, true, JSON.stringify({ uploadPayload, uploadUi }));
    const attachmentSendResponsePromise = page.waitForResponse((response) => response.url().includes("/api/v1/wasalx/group_workspace/groups/") && response.url().endsWith("/send") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const attachmentSendResponse = await attachmentSendResponsePromise;
    const attachmentSendPayload = await attachmentSendResponse.json();
    assert.equal(attachmentSendResponse.status(), 202, JSON.stringify(attachmentSendPayload));
    await page.locator(`[data-message-id="${state.sentMessages[0].id}"]`)
      .filter({ hasText: "proof.png" }).waitFor();
    const attachmentSendUi = await page.evaluate(() => ({
      error: document.querySelector("#wasalx-group-message-error")?.textContent?.trim() || null,
      visible: document.body.innerText.includes("proof.png"),
    }));
    assert.equal(attachmentSendUi.error, null, JSON.stringify({ attachmentSendPayload, attachmentSendUi }));
    assert.equal(attachmentSendUi.visible, true, JSON.stringify({ attachmentSendPayload, attachmentSendUi }));
    const attachment = state.requests.filter((request) => request.path.endsWith("/send")).at(-1)?.body?.attachments?.[0];
    assert.equal(attachment?.filename, "proof.png");
    assert.equal(attachment?.mimeType, "image/png");

    await page.getByRole("button", { name: "Load earlier messages" }).click();
    await page.getByText("Archived shipment SHIP-39", { exact: true }).waitFor();
    assert.ok(state.requests.some((request) => request.path.endsWith("/messages") && request.query.includes("before=")));

    await page.getByRole("button", { name: "Closed", exact: true }).click();
    await page.getByText("Resolved shipment SHIP-40", { exact: true }).last().waitFor();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("link", { name: `Ticket #${state.ticketNumber}` }).waitFor();

    const createMessage = page.locator(`[data-message-id="${createMessageId}"]`);
    await createMessage.getByRole("button", { name: "Create ticket" }).click();
    const createForm = createMessage.locator("form");
    assert.equal(await createForm.getByLabel("Ticket title").inputValue(), "Riyadh Operations — Create shipment SHIP-42");
    await createForm.getByRole("button", { name: "Create ticket" }).click();
    await page.getByRole("link", { name: /Open ticket #/u }).waitFor();

    const linkMessage = page.locator(`[data-message-id="${linkMessageId}"]`);
    await linkMessage.getByRole("button", { name: "Link to ticket" }).click();
    const linkForm = linkMessage.locator("form");
    await linkForm.getByLabel("Ticket number").fill(String(state.ticketNumber));
    await linkForm.getByRole("button", { name: "Link message" }).click();
    await page.getByRole("link", { name: `Open ticket #${state.ticketNumber}` }).waitFor();

    const heading = page.getByRole("heading", { name: "WhatsApp Groups" });
    await heading.evaluate((element) => element.closest(".flex.h-full")?.setAttribute("data-wasalx-test-root", ""));
    assert.equal(await page.locator("[data-wasalx-test-root]").count(), 1);
    const axe = await new AxeBuilder({ page }).include("[data-wasalx-test-root]").analyze();
    assert.deepEqual(axe.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? "")), []);
    await page.screenshot({ path: join(evidenceDirectory, "group-workspace.png"), fullPage: true });

    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    for (const width of [820, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const narrowLayout = await page.locator("[data-wasalx-test-root]").evaluate((element) => ({
      overflow: Math.max(0, element.scrollWidth - element.clientWidth),
      right: element.getBoundingClientRect().right,
      offenders: [...element.querySelectorAll("*")]
        .map((candidate) => ({
          className: typeof candidate.className === "string" ? candidate.className : candidate.tagName,
          overflow: Math.max(0, candidate.scrollWidth - candidate.clientWidth),
        }))
        .filter((candidate) => candidate.overflow > 1)
        .sort((left, right) => right.overflow - left.overflow)
        .slice(0, 5),
    }));
    assert.ok(narrowLayout.overflow <= 1 && narrowLayout.right <= width + 1, `group workspace overflows ${width} CSS px: ${JSON.stringify(narrowLayout)}`);
    await page.screenshot({ path: join(evidenceDirectory, `group-workspace-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();

    const ticketLink = page.getByRole("link", { name: `Ticket #${state.ticketNumber}` }).first();
    assert.match(await ticketLink.getAttribute("href") ?? "", new RegExp(`^/desktop/tickets/${state.ticketId}(?:[?#]|$)`, "u"));
    await ticketLink.click();
    await page.waitForURL((url) => url.pathname.includes(`/tickets/${state.ticketId}`));
    const articleBubble = page.getByText("Existing shipment SHIP-41", { exact: true }).last()
      .locator("xpath=ancestor::div[contains(@class, 'group/article')][1]");
    await articleBubble.waitFor({ state: "visible" });
    await articleBubble.hover();
    await articleBubble.getByRole("button", { name: "Reply on WhatsApp" }).waitFor({ state: "visible" });
    const wasalxSidebar = page.getByRole("button", { name: "WasalX operations" });
    await wasalxSidebar.waitFor({ state: "visible" });
    await wasalxSidebar.click();
    await page.getByRole("region", { name: "Riyadh Operations" }).filter({ hasText: `#${state.ticketNumber}` }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Show triggering message" }).waitFor({ state: "visible" });
    await page.screenshot({ path: join(evidenceDirectory, "ticket-plugins.png"), fullPage: true });

    // Native save/reset regression. Client responses and state mirrors are simulated;
    // actual Rails, GraphQL, article/storage, WebSocket and mounted-form behavior are tested.
    const replyMarker = 'WX-NATIVE-NEW-PDF-RESET';
    const replyBody = `مرحباً، استلم فريق الدعم طلبكم. مرفق مستند الاختبار. ${replyMarker}`;
    const replyPdf = Buffer.from('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNjMgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA0MCAxNTAgVGQgKFdhc2FsWCBzeW50aGV0aWMgYWxwaGEgZG9jdW1lbnQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjMKJSVFT0YK', 'base64');
    const replySnapshot = async (ticketId = state.ticketId, expectedBody = replyBody) => {
      const raw = await dockerAsync(directory, project, 'exec', '-T', 'zammad-railsserver', 'bundle', 'exec', 'rails', 'runner', `
        require 'json'; t = Ticket.find(${Number(ticketId)})
        rows = Ticket::Article.where(ticket_id: t.id, internal: false,
          sender_id: Ticket::Article::Sender.find_by!(name: 'Agent').id,
          type_id: Ticket::Article::Type.find_by!(name: 'wasalx group message').id).order(:id).map do |a|
          { id: a.id, in_reply_to: a.in_reply_to, matches: a.body.to_s == ${JSON.stringify(expectedBody)}, delivery_id: a.preferences['wasalx_delivery_id'],
            pdf: Store.list(object: 'Ticket::Article', o_id: a.id).any? { |s| s.filename == 'native-reset-proof.pdf' } }
        end
        puts JSON.generate(state: t.state.name, rows: rows,
          open_id: Ticket::State.find_by!(name: 'open').id, closed_id: Ticket::State.find_by!(name: 'closed').id,
          job_ids: Delayed::Job.order(:id).pluck(:id))
      `);
      return JSON.parse(raw.split('\n').find(line => line.startsWith('{')) ?? '');
    };
    const submitReplyTicket = async (articleExpected) => {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/graphql')
        && response.request().method() === 'POST'
        && /^ticketUpdate$/iu.test(response.request().postDataJSON()?.operationName ?? ''), { timeout: 60_000 });
      await page.getByRole('button', { name: 'Update', exact: true }).click();
      const response = await pending; const data = await response.json();
      assert.equal(response.status(), 200); assert.ok(!data.errors?.length);
      assert.ok(!data.data?.ticketUpdate?.errors?.length); assert.ok(data.data?.ticketUpdate?.ticket);
      assert.equal(response.request().postDataJSON()?.variables?.input?.article != null, articleExpected);
    };
    const assertReplyReset = async (marker = replyMarker) => {
      await page.waitForFunction(marker => ![...document.querySelectorAll('[contenteditable="true"]')]
        .some(node => node.textContent.includes(marker)), marker, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Discard unsaved reply', exact: true }).waitFor({ state: 'hidden', timeout: 30_000 });
      await page.getByText('Discard your unsaved changes', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 });
    };
    // The plugin screenshot selected WasalX operations; native fields are rendered
    // only while the Ticket sidebar is selected. This changes no persisted state.
    await page.getByRole('button', { name: 'Ticket', exact: true }).click();
    await page.getByRole('combobox', { name: 'State', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    const beforeReply = await replySnapshot(); assert.equal(beforeReply.state, 'new');
    await page.getByRole('combobox', { name: 'State', exact: true }).getByText(/^new$/iu).waitFor({ timeout: 30_000 });
    await articleBubble.hover(); await articleBubble.getByRole('button', { name: 'Reply on WhatsApp', exact: true }).click();
    await page.locator('[contenteditable="true"]').fill(replyBody);
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'native-reset-proof.pdf', mimeType: 'application/pdf', buffer: replyPdf });
    await page.getByText('native-reset-proof.pdf', { exact: true }).waitFor();
    await submitReplyTicket(true);
    const afterReply = await replySnapshot(); const addedReply = afterReply.rows.filter(row => !beforeReply.rows.some(old => old.id === row.id));
    assert.equal(afterReply.state, 'open'); assert.equal(addedReply.length, 1);
    assert.equal(addedReply[0].matches && addedReply[0].pdf, true); await assertReplyReset();
    const outboundStart = state.requests.length;
    // Only this new article's owned job is invoked, once. No scheduler, retry or unrelated queue execution.
    const communicateReply = async (articleId) => {
      const communicated = await dockerAsync(directory, project, 'exec', '-T', 'zammad-railsserver', 'bundle', 'exec', 'rails', 'runner', `
      require 'json'; a = Ticket::Article.find(${Number(articleId)})
      jobs = Delayed::Job.where('handler LIKE ?', '%CommunicateWasalxJob%').to_a.select { |j| j.payload_object.job_data['arguments'] == [a.id] }
      raise 'Owned communication cardinality' unless jobs.length == 1
      j = jobs.first; raise 'Owned communication already active' if j.locked_at || j.failed_at
      j.invoke_job; raise 'Owned communication outcome unknown' unless a.reload.preferences['wasalx_delivery_id'].present?
      j.destroy!; puts JSON.generate(invocations: 1)
    `);
    assert.equal(JSON.parse(communicated.split('\n').find(line => line.startsWith('{'))).invocations, 1);
    };
    await communicateReply(addedReply[0].id);
    assert.equal(state.requests.slice(outboundStart).filter(request => request.method === 'POST'
      && request.path === '/internal/v1/zammad/outbound' && Number(request.body.article_id) === addedReply[0].id).length, 1);
    await assertReplyReset();
    // Keep this same mounted form through supported native API close/reopen mirrors.
    for (const stateId of [afterReply.closed_id, afterReply.open_id]) {
      const response = await fetch(`${zammadOrigin}/api/v1/tickets/${state.ticketId}`, {
        method: 'PUT', headers: { Authorization: `Token token=${serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ state_id: stateId }), signal: AbortSignal.timeout(60_000),
      });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value.error ? { error: value.error, error_human: value.error_human } : { fixture: 'group-state-mirror', stateId }));
      assert.equal(Number(value.id), Number(state.ticketId)); assert.equal(Number(value.state_id), stateId);
      await page.getByRole('combobox', { name: 'State', exact: true })
        .getByText(stateId === afterReply.closed_id ? /^closed$/iu : /^open$/iu).waitFor({ timeout: 30_000 });
    }
    const replyState = page.getByRole('combobox', { name: 'State', exact: true });
    await replyState.getByText(/^open$/iu).waitFor(); await replyState.click();
    await page.getByRole('option', { name: /^closed$/iu }).click(); await submitReplyTicket(false);
    const closedReply = await replySnapshot(); assert.equal(closedReply.state, 'closed');
    assert.deepEqual(closedReply.rows.map(row => row.id), afterReply.rows.map(row => row.id));
    assert.ok(beforeReply.job_ids.every(id => closedReply.job_ids.includes(id))); await assertReplyReset();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Existing shipment SHIP-41', exact: true }).first().waitFor();
    await assertReplyReset();
    assert.deepEqual((await replySnapshot()).rows.map(row => row.id), closedReply.rows.map(row => row.id));

    // Mirror only native ownership fields; this is not a real WasalX bot/provider-engine cycle.
    const directMarker = 'WX-NATIVE-DIRECT-RESET'; const directBody = `تم استلام طلبكم. ${directMarker}`;
    const directSeed = await dockerAsync(directory, project, 'exec', '-T', 'zammad-railsserver', 'bundle', 'exec', 'rails', 'runner', `
      require 'json'; original = Ticket.find(${Number(state.ticketId)})
      t = Ticket.create!(title: 'Direct mounted-form HUMAN', group_id: original.group_id,
        customer_id: original.customer_id, state_id: Ticket::State.find_by!(name: 'open').id,
        created_by_id: original.customer_id, updated_by_id: original.customer_id,
        wasalx_connection_id: '${connectionId}', wasalx_group_id: '12125550104@c.us',
        wasalx_group_name: 'Direct fixture customer', wasalx_provider: 'WAHA',
        wasalx_correlation_status: 'OPEN', wasalx_bot_conversation: 'true', wasalx_bot_state: 'HUMAN')
      direct_article = Ticket::Article.create!(ticket: t, sender: Ticket::Article::Sender.find_by!(name: 'Customer'),
        type: Ticket::Article::Type.find_by!(name: 'wasalx group message'), internal: false,
        content_type: 'text/plain', body: 'Direct fixture request', preferences: { 'wasalx_origin' => 'provider' },
        created_by_id: original.customer_id, updated_by_id: original.customer_id)
      # A persisted provider article can legitimately have no native Message-ID.
      # Clear it after callbacks, then prove the actual GraphQL/browser fallback.
      direct_article.update_columns(message_id: nil, message_id_md5: nil)
      raise 'Empty native Message-ID fixture was not persisted' unless direct_article.reload.message_id.nil?
      puts JSON.generate(id: t.id, article_id: direct_article.id, message_id: direct_article.message_id)
    `);
    const directFixture = JSON.parse(directSeed.split('\n').find(line => line.startsWith('{')));
    assert.equal(directFixture.message_id, null);
    state.directReplyTicketId = directFixture.id;
    state.directBotState = 'HUMAN';
    await page.goto(`${zammadOrigin}/desktop/tickets/${state.directReplyTicketId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Direct mounted-form HUMAN', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Ticket', exact: true }).click();
    await replyState.waitFor({ state: 'visible', timeout: 30_000 });
    const directBubble = page.getByText('Direct fixture request', { exact: true }).last()
      .locator("xpath=ancestor::div[contains(@class, 'group/article')][1]");
    const directAction = directBubble.getByRole('button', { name: 'Reply on WhatsApp', exact: true });
    const directBefore = await replySnapshot(state.directReplyTicketId, directBody);
    assert.equal(directBefore.state, 'open'); assert.equal(directBefore.rows.length, 0);
    const directMutations = [];
    const recordDirectMutation = request => {
      if (new URL(request.url()).pathname.endsWith('/graphql') && request.method() === 'POST'
        && /^ticketUpdate$/iu.test(request.postDataJSON()?.operationName ?? '')) {
        directMutations.push({ article: request.postDataJSON()?.variables?.input?.article != null });
      }
    };
    page.on('request', recordDirectMutation);
    try {
      await directBubble.hover(); await directAction.click(); await page.locator('[contenteditable="true"]').fill(directBody);
      await replyState.click(); await page.getByRole('option', { name: /^closed$/iu }).click(); await submitReplyTicket(true);
      const directSaved = await replySnapshot(state.directReplyTicketId, directBody);
      assert.equal(directSaved.state, 'closed'); assert.equal(directSaved.rows.length, 1);
      assert.equal(directSaved.rows[0].matches, true);
      assert.equal(directSaved.rows[0].in_reply_to, `wasalx-article:${directFixture.article_id}`);
      await assertReplyReset(directMarker);
      const directOutboundStart = state.requests.length; await communicateReply(directSaved.rows[0].id);
      const directOutputs = () => state.requests.slice(directOutboundStart).filter(request => request.method === 'POST'
        && request.path === '/internal/v1/zammad/outbound' && Number(request.body.ticket_id) === state.directReplyTicketId);
      assert.equal(directOutputs().length, 1); assert.equal(directOutputs()[0].body.article_id, directSaved.rows[0].id);
      assert.equal(directOutputs()[0].body.reply_to_article_id, String(directFixture.article_id));
      assert.equal(directOutputs()[0].body.reply_to_message_id, undefined);
      const directDelivered = await replySnapshot(state.directReplyTicketId, directBody);
      assert.equal(directDelivered.rows[0].delivery_id, '14000000-0000-4000-8000-000000000099');
      // Distinct headings prove each actual subscription reached the same mounted ticket form.
      for (const [botState, stateId, nativeLabel] of [['RESOLVED', directSaved.closed_id, 'closed'],
        ['BOT', directSaved.open_id, 'open'], ['HUMAN', directSaved.open_id, 'open']]) {
        state.directBotState = botState;
        const title = `Direct mounted-form ${botState}`;
        const response = await fetch(`${zammadOrigin}/api/v1/tickets/${state.directReplyTicketId}`, {
          method: 'PUT', headers: { Authorization: `Token token=${serviceToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ state_id: stateId, title, wasalx_bot_state: botState }), signal: AbortSignal.timeout(60_000),
        });
        const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value.error ? { error: value.error, error_human: value.error_human } : { fixture: 'direct-state-mirror', botState, stateId }));
        assert.equal(Number(value.id), state.directReplyTicketId); assert.equal(Number(value.state_id), stateId);
        assert.equal(value.wasalx_bot_state, botState);
        await page.getByRole('heading', { name: title, exact: true }).first().waitFor({ timeout: 30_000 });
        await replyState.getByText(new RegExp(`^${nativeLabel}$`, 'iu')).waitFor({ timeout: 30_000 });
        await directBubble.hover(); await directAction.waitFor({ state: botState === 'HUMAN' ? 'visible' : 'hidden', timeout: 30_000 });
        await assertReplyReset(directMarker);
      }
      // Do not reload or open a second composer before this previously blocked state-only save.
      await replyState.click(); await page.getByRole('option', { name: /^closed$/iu }).click(); await submitReplyTicket(false);
      const directClosed = await replySnapshot(state.directReplyTicketId, directBody);
      assert.equal(directClosed.state, 'closed'); assert.deepEqual(directClosed.rows, directDelivered.rows);
      assert.deepEqual(directMutations, [{ article: true }, { article: false }]); assert.equal(directOutputs().length, 1);
      await assertReplyReset(directMarker); await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Ticket', exact: true }).click();
      await replyState.waitFor({ state: 'visible', timeout: 30_000 });
      await replyState.getByText(/^closed$/iu).waitFor({ timeout: 30_000 }); await assertReplyReset(directMarker);
      assert.deepEqual((await replySnapshot(state.directReplyTicketId, directBody)).rows, directClosed.rows);
    } finally { page.off('request', recordDirectMutation); }
    await page.goto(`${zammadOrigin}/desktop/tickets/${state.ticketId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Existing shipment SHIP-41', exact: true }).first().waitFor();

    // Reuse the owned native fixture/session; do not save a ticket or send a message.
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, timezoneId: "Asia/Riyadh",
      isMobile: true, hasTouch: true, storageState: await context.storageState(),
    });
    const mobilePage = await mobileContext.newPage();
    const mobileStart = state.requests.length;
    const mobileMutations = [];
    const mobileFailures = [];
    const mobileState = () => mobilePage.evaluate(() => ({
      width: innerWidth, height: innerHeight, coarse: matchMedia("(any-pointer: coarse)").matches,
      document: { clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight,
        bodyClientHeight: document.body.clientHeight, bodyScrollHeight: document.body.scrollHeight },
    }));
    const checkMobileState = async (phase) => {
      const current = await mobileState();
      await writeFile(join(evidenceDirectory, `native-mobile-${phase}-state.json`), JSON.stringify(current, null, 2));
      assert.deepEqual({ width: current.width, height: current.height, coarse: current.coarse },
        { width: 390, height: 844, coarse: true }, `native mobile emulation changed at ${phase}`);
    };
    const mobileScreenshot = async (name) => {
      await checkMobileState(`${name}-before-capture`);
      await mobilePage.screenshot({ path: join(evidenceDirectory, `native-mobile-${name}-390.png`), fullPage: false });
      await checkMobileState(`${name}-after-capture`);
    };
    let nativeMobileStorageState;
    let mobilePhase = "navigation";
    mobilePage.on("request", (request) => {
      if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/graphql")) return;
      const payload = request.postDataJSON();
      if (typeof payload?.operationName === "string") mobileMutations.push(payload.operationName);
    });
    try {
      await mobilePage.goto(`${zammadOrigin}/mobile/account`, { waitUntil: "domcontentloaded" });
      await mobilePage.getByRole("link", { name: "Continue to desktop", exact: true }).click();
      await mobilePage.waitForURL((url) => url.pathname.startsWith("/desktop"));
      assert.equal(await mobilePage.evaluate(() => JSON.parse(localStorage.getItem("forceDesktopApp") ?? "false")), true);
      await mobilePage.locator("#user-menu").click();
      await mobilePage.getByRole("button", { name: "Continue to mobile", exact: true }).click();
      await mobilePage.waitForURL((url) => url.pathname.startsWith("/mobile"));
      assert.equal(await mobilePage.evaluate(() => JSON.parse(localStorage.getItem("forceDesktopApp") ?? "false")), false);
      await mobilePage.goto(`${zammadOrigin}/mobile/account`, { waitUntil: "domcontentloaded" });
      await mobilePage.getByRole("link", { name: "Continue to desktop", exact: true }).click();
      await mobilePage.waitForURL((url) => url.pathname.startsWith("/desktop"));
      await mobilePage.locator("#user-menu").click();
      await mobilePage.getByRole("button", { name: "WhatsApp Groups on mobile", exact: true }).click();
      await mobilePage.waitForURL((url) => url.pathname === "/mobile/wasalx/groups");
      assert.equal(await mobilePage.evaluate(() => matchMedia("(any-pointer: coarse)").matches), true);
      await mobilePage.getByText("Riyadh Operations", { exact: true }).first().click();
      await mobilePage.locator(`[data-message-id="${existingMessageId}"]`).getByText("Existing shipment SHIP-41", { exact: true }).waitFor();
      // The completed desktop close proof leaves this owned ticket in the Closed view.
      const mobileTicketStatus = mobilePage.getByRole("group", { name: "Ticket status", exact: true });
      assert.equal(await mobileTicketStatus.getByRole("button", { name: "Open", exact: true }).getAttribute("aria-pressed"), "true");
      await mobileTicketStatus.getByRole("button", { name: "Closed", exact: true }).click();
      assert.equal(await mobileTicketStatus.getByRole("button", { name: "Closed", exact: true }).getAttribute("aria-pressed"), "true");
      const closedFixtureLink = mobilePage.getByRole("link", { name: `Ticket #${state.ticketNumber}`, exact: true });
      await closedFixtureLink.waitFor({ state: "visible", timeout: 30_000 });
      await mobilePage.locator(".wasalx-ticket-list article").filter({ has: closedFixtureLink })
        .getByText("Closed", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      const mobileGeometry = async (locator, surface) => {
        const geometry = await locator.evaluate((root) => {
          const describe = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const inset = /^inset\(([^)]*)\)$/u.exec(style.clipPath);
            let emptyInsetClip = false;
            if (inset) {
              const parts = inset[1].split(/\s+round\s+/u)[0].trim().split(/\s+/u);
              if (parts.length >= 1 && parts.length <= 4 && parts.every((part) => /^-?(?:\d*\.)?\d+(?:px|%)?$/u.test(part))) {
                const [top, right = top, bottom = top, left = right] = parts;
                const pixels = (part, size) => Number.parseFloat(part) * (part.endsWith("%") ? size / 100 : 1);
                emptyInsetClip = pixels(top, rect.height) + pixels(bottom, rect.height) >= rect.height
                  || pixels(left, rect.width) + pixels(right, rect.width) >= rect.width;
              }
            }
            const displayed = element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
              && style.visibility !== "hidden" && style.clip !== "rect(0px, 0px, 0px, 0px)" && !emptyInsetClip;
            return {
              tag: element.tagName, text: element.textContent?.trim().slice(0, 240) ?? "",
              ariaLabel: element.getAttribute("aria-label"), id: element.id, classes: element.className,
              html: element.outerHTML.slice(0, 1200),
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              display: style.display, visibility: style.visibility, position: style.position,
              clip: style.clip, clipPath: style.clipPath, emptyInsetClip, displayed,
              minWidth: style.minWidth, minHeight: style.minHeight,
              minInlineSize: style.minInlineSize, minBlockSize: style.minBlockSize,
              fontSize: Number.parseFloat(style.fontSize), focused: document.activeElement === element,
            };
          };
          const targetCandidates = [...root.querySelectorAll("button,a,summary")].map(describe);
          const inputCandidates = [...root.querySelectorAll('input:not([type="hidden"]):not([type="file"]),textarea,select')].map(describe);
          return {
            overflow: Math.max(0, root.scrollWidth - root.clientWidth), right: root.getBoundingClientRect().right,
            root: { clientHeight: root.clientHeight, scrollHeight: root.scrollHeight, height: root.getBoundingClientRect().height,
              overflowY: getComputedStyle(root).overflowY },
            ancestors: (() => {
              const rows = [];
              for (let node = root.parentElement; node && rows.length < 6; node = node.parentElement) {
                rows.push({ tag: node.tagName, id: node.id, classes: node.className, clientHeight: node.clientHeight,
                  scrollHeight: node.scrollHeight, height: node.getBoundingClientRect().height, overflowY: getComputedStyle(node).overflowY });
              }
              return rows;
            })(),
            targetCandidates, targets: targetCandidates.filter((target) => target.displayed),
            inputCandidates, inputSizes: inputCandidates.filter((input) => input.displayed).map((input) => input.fontSize),
          };
        });
        // Preserve every candidate and the rendered state before evaluating a gate.
        await writeFile(join(evidenceDirectory, `native-mobile-${surface}-geometry.json`), JSON.stringify(geometry, null, 2));
        await mobileScreenshot(surface);
        if (!(geometry.overflow <= 1 && geometry.right <= 391)) mobileFailures.push({ surface, check: "overflow", geometry });
        const undersized = geometry.targets.filter((target) => target.width < 43.5 || target.height < 43.5);
        if (!geometry.targets.length || undersized.length) mobileFailures.push({ surface, check: "44px targets", targets: undersized });
        if (!geometry.inputSizes.every((size) => size >= 16)) mobileFailures.push({ surface, check: "16px inputs", inputs: geometry.inputCandidates });
        return geometry;
      };
      mobilePhase = "groups-geometry-and-accessibility";
      const mobileGroupGeometry = await mobileGeometry(mobilePage.locator(".wasalx-groups-content"), "groups");
      await checkMobileState("groups-before-axe");
      const mobileGroupsAxe = await new AxeBuilder({ page: mobilePage }).include(".wasalx-groups-content").analyze();
      await checkMobileState("groups-after-axe");
      await writeFile(join(evidenceDirectory, "native-mobile-groups-axe.json"), JSON.stringify(mobileGroupsAxe, null, 2));
      const mobileGroupsViolations = mobileGroupsAxe.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""));
      if (mobileGroupsViolations.length) mobileFailures.push({ surface: "groups", check: "axe", violations: mobileGroupsViolations });
      mobilePhase = "groups-scroll-containment";
      const groupScrollSamples = [];
      const recordGroupScroll = async (phase) => {
        const sample = await mobilePage.evaluate(() => {
          const workspace = document.querySelector(".wasalx-workspace");
          const composer = document.querySelector("#wasalx-group-message");
          const rect = composer.getBoundingClientRect();
          return { height: innerHeight, documentHeight: document.scrollingElement.scrollHeight,
            windowY: scrollY, innerTop: workspace.scrollTop, innerHeight: workspace.clientHeight,
            innerScrollHeight: workspace.scrollHeight, composerFocused: document.activeElement === composer,
            composerTop: rect.top, composerBottom: rect.bottom,
            visibleBottom: document.querySelector("[data-bottom-navigation]").getBoundingClientRect().top };
        });
        groupScrollSamples.push({ phase, ...sample });
        return sample;
      };
      const scrollStart = await recordGroupScroll("initial");
      // The conversation heading is outside both nested list/timeline scrollers.
      const conversationHeading = mobilePage.getByRole("heading", { name: "Riyadh Operations", exact: true });
      await conversationHeading.scrollIntoViewIfNeeded();
      const headingBox = await conversationHeading.boundingBox();
      assert.ok(headingBox, "native Groups conversation heading must be rendered");
      const wheelStart = await recordGroupScroll("conversation-heading");
      const wheelDelta = wheelStart.innerTop < (wheelStart.innerScrollHeight - wheelStart.innerHeight) / 2 ? 650 : -650;
      await mobilePage.mouse.move(headingBox.x + headingBox.width / 2, headingBox.y + headingBox.height / 2);
      await mobilePage.mouse.wheel(0, wheelDelta);
      await mobilePage.waitForFunction((top) => Math.abs(document.querySelector(".wasalx-workspace").scrollTop - top) > 1,
        wheelStart.innerTop, { timeout: 5_000 }).catch((error) => mobileFailures.push({ surface: "groups", check: "inner wheel scroll", error: error.message }));
      await recordGroupScroll("inner-wheel");
      const composerSkip = mobilePage.getByRole("link", { name: "Skip to message composer", exact: true });
      await composerSkip.focus();
      await composerSkip.press("Enter");
      await mobilePage.waitForFunction(() => document.activeElement?.id === "wasalx-group-message", null,
        { timeout: 5_000 }).catch((error) => mobileFailures.push({ surface: "groups", check: "skip composer focus", error: error.message }));
      const focusedComposer = await recordGroupScroll("skip-composer");
      if (!focusedComposer.composerFocused || focusedComposer.composerTop < -1 || focusedComposer.composerBottom > focusedComposer.visibleBottom + 1)
        mobileFailures.push({ surface: "groups", check: "composer reachability", sample: focusedComposer });
      // The form's inline padding is outside the textarea and has workspace as its scroll owner.
      const composerFormBox = await mobilePage.locator(".wasalx-conversation form").boundingBox();
      assert.ok(composerFormBox, "native Groups composer form must remain rendered");
      await mobilePage.mouse.move(composerFormBox.x + 2, Math.max(1, Math.min(740, composerFormBox.y + composerFormBox.height - 2)));
      await mobilePage.mouse.wheel(0, scrollStart.innerScrollHeight);
      await mobilePage.waitForFunction(() => {
        const workspace = document.querySelector(".wasalx-workspace");
        return workspace.scrollTop + workspace.clientHeight >= workspace.scrollHeight - 1;
      }, null, { timeout: 5_000 }).catch((error) => mobileFailures.push({ surface: "groups", check: "transcript bottom reachability", error: error.message }));
      await recordGroupScroll("inner-bottom");
      await mobilePage.mouse.move(195, 740);
      await mobilePage.mouse.wheel(0, 1000);
      // Two rendered frames let the input settle without changing document scroll or styles.
      await mobilePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await recordGroupScroll("bottom-wheel");
      await writeFile(join(evidenceDirectory, "native-mobile-groups-scroll.json"), JSON.stringify(groupScrollSamples, null, 2));
      const groupLinkedTicket = mobilePage.getByRole("link", { name: `Ticket #${state.ticketNumber}` }).first();
      await groupLinkedTicket.scrollIntoViewIfNeeded();
      const linkedTicketBox = await groupLinkedTicket.boundingBox();
      const ticketScroll = await recordGroupScroll("linked-ticket");
      if (!linkedTicketBox || linkedTicketBox.y < -1 || linkedTicketBox.y + linkedTicketBox.height > ticketScroll.visibleBottom + 1)
        mobileFailures.push({ surface: "groups", check: "linked ticket reachability", box: linkedTicketBox });
      await writeFile(join(evidenceDirectory, "native-mobile-groups-scroll.json"), JSON.stringify(groupScrollSamples, null, 2));
      await mobileScreenshot("groups-scroll");
      for (const sample of groupScrollSamples) {
        if (sample.documentHeight > sample.height + 1 || Math.abs(sample.windowY - scrollStart.windowY) > 1)
          mobileFailures.push({ surface: "groups", check: "outer document scroll containment", sample });
      }

      mobilePhase = "ticket-navigation-and-operations";
      const nativeMobileTicket = mobilePage.getByRole("link", { name: `Ticket #${state.ticketNumber}` }).first();
      assert.match(await nativeMobileTicket.getAttribute("href") ?? "", new RegExp(`^/mobile/tickets/${state.ticketId}(?:[?#]|$)`, "u"));
      await nativeMobileTicket.click();
      await mobilePage.waitForURL((url) => url.pathname === `/mobile/tickets/${state.ticketId}`);
      await mobilePage.getByRole("button", { name: "Show ticket actions", exact: true }).click();
      await mobilePage.getByRole("button", { name: "Ticket info", exact: true }).click();
      await mobilePage.getByRole("tab", { name: "WasalX operations", exact: true }).click();
      const operations = mobilePage.getByRole("region", { name: "WasalX operations", exact: true });
      await operations.getByRole("region", { name: "Riyadh Operations", exact: true }).waitFor();
      assert.equal(await operations.locator('[data-test-id="wasalx-delivery-retry"]').count(), 0);
      const trigger = operations.getByRole("link", { name: "Show triggering message", exact: true });
      assert.equal(await trigger.getAttribute("href"), `/mobile/wasalx/groups?group=${groupId}&message=${existingMessageId}`);
      const mobileTicketGeometry = await mobileGeometry(operations, "ticket-operations");
      await checkMobileState("ticket-operations-before-axe");
      const mobileAxe = await new AxeBuilder({ page: mobilePage }).include('section[aria-label="WasalX operations"]').analyze();
      await checkMobileState("ticket-operations-after-axe");
      await writeFile(join(evidenceDirectory, "native-mobile-ticket-operations-axe.json"), JSON.stringify(mobileAxe, null, 2));
      const mobileTicketViolations = mobileAxe.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""));
      if (mobileTicketViolations.length) mobileFailures.push({ surface: "ticket-operations", check: "axe", violations: mobileTicketViolations });
      mobilePhase = "trigger-navigation";
      await trigger.click();
      await mobilePage.waitForURL((url) => url.pathname === "/mobile/wasalx/groups" && url.searchParams.get("message") === existingMessageId);
      await mobilePage.locator(`[data-message-id="${existingMessageId}"]`).waitFor();
      await mobilePage.goto(`${zammadOrigin}/mobile/tickets/${state.ticketId}`, { waitUntil: "domcontentloaded" });
      mobilePhase = "reply-draft-attachment-discard";
      await mobilePage.getByRole("button", { name: "Add reply", exact: true }).click();
      const reply = mobilePage.getByRole("dialog", { name: "Add reply", exact: true });
      await reply.getByRole("combobox", { name: "Channel", exact: true }).click();
      await mobilePage.getByRole("dialog", { name: "Dialog window with selections", exact: true }).getByRole("option", { name: "WhatsApp", exact: true }).click();
      assert.ok((await reply.getByRole("combobox", { name: "Channel", exact: true }).innerText()).includes("WhatsApp"));
      await reply.locator('[contenteditable="true"]').pressSequentially("Mobile draft \u2014 do not send.", { delay: 20 });
      // Native cancellation prompts only after FormKit recognizes an article change.
      await reply.getByRole("button", { name: "Done", exact: true }).click({ trial: true });
      const chooserPromise = mobilePage.waitForEvent("filechooser");
      await reply.getByRole("button", { name: "Attach files", exact: true }).click();
      const chooser = await chooserPromise;
      await mobileScreenshot("reply-attachment");
      assert.equal(chooser.isMultiple(), true);
      assert.equal(await reply.locator('input[type="file"]').evaluate((input) => input.files?.length ?? 0), 0);
      // No file is selected; cancel the draft rather than triggering an empty upload.
      await reply.getByRole("button", { name: "Cancel", exact: true }).click();
      await mobilePage.getByRole("button", { name: "Discard changes", exact: true }).click();
      await reply.waitFor({ state: "hidden" });
      assert.equal(await mobilePage.getByRole("button", { name: "Edit reply", exact: true }).count(), 0);
      mobilePhase = "state-chooser";
      await mobilePage.getByRole("button", { name: "Show ticket actions", exact: true }).click();
      await mobilePage.getByRole("button", { name: "Ticket info", exact: true }).click();
      const stateField = mobilePage.getByRole("combobox", { name: "State", exact: true });
      const originalStateLabel = await stateField.innerText();
      await stateField.click();
      const selectionDialog = mobilePage.getByRole("dialog", { name: "Dialog window with selections", exact: true });
      await selectionDialog.getByRole("listbox").waitFor();
      await mobileScreenshot("state-chooser");
      await mobilePage.keyboard.press("Escape");
      await selectionDialog.waitFor({ state: "hidden" });
      assert.equal(await stateField.innerText(), originalStateLabel);
      mobilePhase = "read-only-mutation-guards";
      assert.equal(mobileMutations.some((name) => /ticketUpdate|formUploadCacheAdd/iu.test(name)), false);
      const mobileControlMutations = state.requests.slice(mobileStart).filter((request) => request.method !== "GET");
      assert.ok(mobileControlMutations.every((request) => request.method === "POST"
        && request.path === `/internal/v1/zammad/group-workspace/groups/${groupId}/read`),
      "mobile navigation may only advance the exact owned group's read cursor");
      await writeFile(join(evidenceDirectory, "native-mobile-evidence.json"), JSON.stringify({
        candidate: process.env.GITHUB_SHA ?? "local", image, evidenceMode: "simulated", nativeUi: true,
        viewport: { width: 390, height: 844 }, coarsePointer: true, locale: "en",
        groupGeometry: mobileGroupGeometry, ticketGeometry: mobileTicketGeometry,
        ticketId: state.ticketId, contextualMessageId: existingMessageId,
        draftDiscarded: true, attachmentChooserOpenedNoFileChosen: true, stateChooserCancelled: true,
        ticketUpdateMutations: 0, uploadMutations: 0, outboundMutations: 0,
        ownedGroupReadCursorMutations: mobileControlMutations.length,
        arabic: "not-qualified-by-this-existing-English-fixture",
        seriousAccessibilityViolations: mobileGroupsViolations.length + mobileTicketViolations.length, mobileFailures,
      }, null, 2));
      nativeMobileStorageState = await mobileContext.storageState();
      // Report the complete visual failure union after the unchanged guarded journeys.
      mobilePhase = "collected-failure-union";
      assert.deepEqual(mobileFailures, [], "native mobile collected failure union");
    } catch (error) {
      const failureStateBeforeCapture = await mobileState().catch((stateError) => ({ error: String(stateError) }));
      const screenshotError = await mobilePage.screenshot({ path: join(evidenceDirectory, "native-mobile-failure.png"), fullPage: false })
        .then(() => null, (captureError) => String(captureError));
      const failureStateAfterCapture = await mobileState().catch((stateError) => ({ error: String(stateError) }));
      await writeFile(join(evidenceDirectory, "native-mobile-failure.json"), JSON.stringify({
        candidate: process.env.GITHUB_SHA ?? "local", image, phase: mobilePhase,
        error: String(error), mobileFailures, screenshotError, failureStateBeforeCapture, failureStateAfterCapture,
        graphqlOperations: mobileMutations, controlRequests: state.requests.slice(mobileStart).map(({ method, path }) => ({ method, path })),
        downstream: "Any later unrecorded phase is BLOCKED, not passed; an incomplete draft/chooser closes this context.",
      }, null, 2));
      throw error;
    } finally {
      await mobileContext.close();
    }

    for (const scenario of scenarios.slice(1)) legacyGrantUiProofs.push(await proveNativeQueueGrant(scenario));
    await setNativeLocale(bootstrapEmail, "en-us");
    const followLatestProofs = [];
    for (const [index, scenario] of scenarios.entries()) {
      await setNativeLocale(agentEmail, scenario.locale);
      const liveId = `17000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, "0")}`;
      const incomingId = `17000000-0000-4000-8000-${String(index * 2 + 2).padStart(12, "0")}`;
      const prefix = scenario.locale === "ar" ? "تحديث الشحنة" : "Shipment update";
      state.liveMessages = [{ id: liveId, participant_name: "Native fixture", message_text: `${prefix} ${scenario.name}`,
        from_me: false, provider_timestamp: "2026-08-21T10:00:00.000Z", latest_mutation: null,
        quote_allowed: true, ticket_creatable: false, linked_to_ticket: false }];
      const matrixContext = await browser.newContext({ viewport: scenario.viewport, timezoneId: "Asia/Riyadh",
        isMobile: scenario.mobile, hasTouch: scenario.mobile, reducedMotion: "reduce",
        storageState: scenario.mobile ? nativeMobileStorageState : await context.storageState() });
      const matrixPage = await matrixContext.newPage();
      const matrixStart = state.requests.length;
      const samples = [];
      let phase = "open";
      const route = `${zammadOrigin}/${scenario.mobile ? "mobile" : "desktop"}/wasalx/groups?group=${groupId}`;
      const sample = async (label) => {
        const value = await matrixPage.locator(".wasalx-timeline").evaluate(element => ({
          top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight,
          gap: element.scrollHeight - element.scrollTop - element.clientHeight,
          width: innerWidth, viewportHeight: innerHeight, coarse: matchMedia("(any-pointer: coarse)").matches,
          lang: document.documentElement.lang, dir: document.documentElement.dir,
        }));
        samples.push({ phase: label, ...value });
        return value;
      };
      const latest = async () => matrixPage.waitForFunction(() => {
        const element = document.querySelector(".wasalx-timeline");
        return element && element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
      }, null, { timeout: 15_000 });
      try {
        await matrixPage.goto(route, { waitUntil: "domcontentloaded" });
        await matrixPage.getByRole("heading", { name: scenario.locale === "ar" ? "مجموعات واتساب" : "WhatsApp Groups", exact: true }).waitFor();
        await matrixPage.locator(`[data-message-id="${liveId}"]`).waitFor();
        await latest();
        const initial = await sample("initial-latest");
        assert.equal(initial.lang, scenario.locale);
        assert.equal(initial.dir, scenario.locale === "ar" ? "rtl" : "ltr");
        assert.equal(initial.width, scenario.viewport.width);
        assert.equal(initial.coarse, scenario.mobile);
        assert.ok(initial.total > initial.height + 300, "timeline must have actual scrollable history");
        phase = "same-message-growth";
        // Change a provider fixture row, not the DOM: normal polling renders the same message ID taller.
        state.liveMessages[0].message_text = Array.from({ length: 20 }, (_, line) => `${prefix} ${line + 1}`).join("\n");
        await matrixPage.locator(`[data-message-id="${liveId}"]`).getByText(`${prefix} 20`, { exact: false }).waitFor({ timeout: 20_000 });
        await latest();
        const grown = await sample("same-message-growth");
        assert.ok(grown.total > initial.total + 100, "native message layout must actually grow");
        phase = "following-viewport-resize";
        await matrixPage.setViewportSize({ width: scenario.viewport.width, height: scenario.viewport.height - 160 });
        await matrixPage.waitForFunction(height => document.querySelector(".wasalx-timeline")?.clientHeight !== height, grown.height);
        await latest();
        await sample("following-viewport-resize");
        phase = "history-anchor";
        const timeline = matrixPage.locator(".wasalx-timeline");
        await timeline.scrollIntoViewIfNeeded();
        const box = await timeline.boundingBox();
        assert.ok(box);
        await matrixPage.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 150));
        await matrixPage.mouse.wheel(0, -650);
        await matrixPage.waitForFunction(() => {
          const element = document.querySelector(".wasalx-timeline");
          return element.scrollHeight - element.scrollTop - element.clientHeight > 300;
        });
        const anchor = await timeline.evaluate(element => {
          const top = element.getBoundingClientRect().top;
          const message = [...element.querySelectorAll("[data-message-id]")].find(item => item.getBoundingClientRect().bottom > top + 1);
          return { id: message.dataset.messageId, offset: message.getBoundingClientRect().top - top };
        });
        state.liveMessages.unshift({ ...state.liveMessages[0], id: incomingId, message_text: `${prefix} incoming`, provider_timestamp: "2026-08-21T10:01:00.000Z" });
        await matrixPage.locator(`[data-message-id="${incomingId}"]`).waitFor({ state: "attached", timeout: 20_000 });
        const anchored = await timeline.evaluate((element, target) => {
          const message = element.querySelector(`[data-message-id="${target.id}"]`);
          return { gap: element.scrollHeight - element.scrollTop - element.clientHeight,
            offset: message.getBoundingClientRect().top - element.getBoundingClientRect().top };
        }, anchor);
        assert.ok(anchored.gap > 120, "incoming message must not pull an operator out of history");
        assert.ok(Math.abs(anchored.offset - anchor.offset) <= 3, "incoming message must preserve the visible history anchor");
        await sample("history-after-incoming");
        phase = "highlighted-context-resize";
        await matrixPage.goto(`${route}&message=${existingMessageId}`, { waitUntil: "domcontentloaded" });
        const highlighted = matrixPage.locator(`[data-message-id="${existingMessageId}"].ring-yellow-300`);
        await highlighted.waitFor();
        const highlightedBefore = await sample("highlighted-context-before-resize");
        await matrixPage.setViewportSize({ width: scenario.viewport.width, height: scenario.viewport.height - 80 });
        await matrixPage.waitForFunction(height => document.querySelector(".wasalx-timeline")?.clientHeight !== height, highlightedBefore.height);
        await matrixPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const contextSample = await sample("highlighted-context-resize");
        assert.ok(contextSample.gap > 120, "context resize must not snap to the latest message");
        assert.ok(await highlighted.isVisible());
        phase = "return-to-latest";
        await matrixPage.getByRole("button", { name: scenario.locale === "ar" ? "العودة إلى الأحدث" : "Return to latest", exact: true }).click();
        await latest();
        await sample("returned-to-latest");
        await matrixPage.screenshot({ path: join(evidenceDirectory, `native-groups-${scenario.name}.png`), fullPage: false });
        const mutations = state.requests.slice(matrixStart).filter(request => request.method !== "GET");
        assert.ok(mutations.every(request => request.method === "POST"
          && request.path === `/internal/v1/zammad/group-workspace/groups/${groupId}/read`));
        const proof = { ...scenario, evidenceMode: "simulated", nativeUi: true, samples, anchor,
          sameMessageGrowth: true, followingResize: true, historyPreserved: true, highlightedContextPreserved: true,
          returnToLatest: true, outboundMutations: 0, readCursorMutations: mutations.length };
        followLatestProofs.push(proof);
        await writeFile(join(evidenceDirectory, `native-groups-${scenario.name}.json`), JSON.stringify(proof, null, 2));
      } catch (error) {
        await matrixPage.screenshot({ path: join(evidenceDirectory, `native-groups-${scenario.name}-failure.png`), fullPage: false }).catch(() => undefined);
        await writeFile(join(evidenceDirectory, `native-groups-${scenario.name}-failure.json`), JSON.stringify({ ...scenario, phase, samples, error: String(error) }, null, 2));
        throw error;
      } finally { await matrixContext.close(); }
    }
    state.liveMessages = [];
    await setNativeLocale(agentEmail, "en-us");
    const containerIds = docker(directory, project, "ps", "--all", "--quiet").split(/\s+/u).filter(Boolean);
    const containers = JSON.parse(execFileSync("docker", ["inspect", ...containerIds], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" }));
    const actualCaps = containers.map(container => {
      const service = container.Config.Labels["com.docker.compose.service"];
      const cap = resourceCaps[service] ?? finiteCap;
      assert.equal(container.HostConfig.Memory, cap.memory, `${service} actual memory cap`);
      assert.equal(container.HostConfig.MemorySwap, cap.memory, `${service} actual swap cap`);
      assert.equal(container.HostConfig.NanoCpus, cap.cpus * 1e9, `${service} actual CPU cap`);
      return { id: container.Id, service, running: container.State.Running, ...cap };
    });
    await writeFile(join(evidenceDirectory, "resource-caps-actual.json"), JSON.stringify(actualCaps, null, 2));

    await writeFile(join(evidenceDirectory, "evidence.json"), JSON.stringify({
      candidate: process.env.GITHUB_SHA ?? "local", image,
      requestPaths: state.requests.map((request) => `${request.method} ${request.path}${request.query}`),
      seriousAccessibilityViolations: 0,
      compiledPlugins: { workspaceRoute: true, ticketSidebar: true, ticketArticleAction: true },
      legacyNativeUsersQueueGrant: legacyGrantUiProofs[0],
      nativeLocaleViewportAcceptance: { permissionSaves: legacyGrantUiProofs, groups: followLatestProofs },
          packageLifecycle: ["predecessor", "current-blocked-by-reference", "current", "rollback", "current"],
    }, null, 2));
    await context.close();
    assert.deepEqual(observedGroupActors, new Set(groupActorExpectations.keys()));
    assert.ok(state.requests.some((request) => request.path.endsWith(`/messages/${createMessageId}/tickets`)));
    assert.ok(state.requests.some((request) => request.path.endsWith(`/messages/${linkMessageId}/tickets`)));
    const createdCustomer = docker(directory, project, "exec", "-T", "zammad-railsserver", "bundle", "exec", "rails", "runner",
      `require 'json'; user=User.find_by!(login: '${createCustomerLogin}'); puts JSON.generate(login:user.login,active:user.active,customer:user.permissions?('ticket.customer'))`);
    assert.deepEqual(JSON.parse(createdCustomer.split("\n").find((line) => line.startsWith("{")) ?? ""), {
      login: createCustomerLogin, active: true, customer: true,
    });
    // The final isolated fixture changes service ownership; no browser work may follow it.
    await browser.close();
    browser = undefined;
    await dockerAsync(directory, project, "stop", "zammad-nginx", "zammad-websocket", "zammad-railsserver");
    await dockerAsync(directory, project, "up", "--detach", "--wait", "--wait-timeout", "60", "mailbox-tls-fixture");
    const nativeSource = await readFile(join(process.cwd(), "tests/portal-workspace-native.rb"));
    const nativeInitializeSource = await readFile(join(process.cwd(), ".zammad-addon/tests/portal-service-initialize-native.rb"));
    const nativeIdentitySource = await readFile(join(process.cwd(), ".zammad-addon/tests/portal-service-identity-native.rb"));
    const nativeTeamSource = await readFile(join(process.cwd(), "tests/team-admin-native.rb"));
    const nativeIdentityRaceSource = await readFile(join(process.cwd(), ".zammad-addon/tests/portal-service-identity-race-native.rb"));
    const nativeRaceSource = await readFile(join(process.cwd(), "tests/team-admin-race-native.rb"));
    const nativeMailboxSource = await readFile(join(process.cwd(), "tests/mailbox-admin-native.rb"));
    const nativeTlsSource = await readFile(join(process.cwd(), "tests/mailbox-driver-tls-native.rb"));
    const nativeOutput = await privateNative("run", "--rm", "--no-deps",
      "--env", "WASALX_TEST_ISOLATED=1", "--env", `WASALX_NATIVE_MAILBOX_TEST_B64=${nativeMailboxSource.toString("base64")}`, "zammad-package", "bundle", "exec", "rails", "runner",
      `require 'base64'; ENV['WASALX_NATIVE_DIAGNOSTIC'] = 'true'
       Module.new.module_eval(Base64.decode64('${nativeInitializeSource.toString("base64")}'), 'portal-service-initialize-native.rb')
       Module.new.module_eval(Base64.decode64('${nativeIdentitySource.toString("base64")}'), 'portal-service-identity-native.rb')
       eval(Base64.decode64('${nativeSource.toString("base64")}'), TOPLEVEL_BINDING, 'portal-workspace-native.rb')
       saved = JSON.parse(File.read('/var/tmp/portal-workspace-fixture.json'))
       ENV['WASALX_ADMIN_TEST_MODE'] = 'simulated'
       ENV['WASALX_ADMIN_TEST_OWNER'] = WasalxMembership.find(saved.fetch('owner')).portal_user_id
       ENV['WASALX_ADMIN_TEST_MEMBER'] = WasalxMembership.find(saved.fetch('agent')).portal_user_id
       Module.new.module_eval(Base64.decode64('${nativeIdentityRaceSource.toString("base64")}'), 'portal-service-identity-race-native.rb')
       Module.new.module_eval(Base64.decode64('${nativeTeamSource.toString("base64")}'), 'team-admin-native.rb')
       Module.new.module_eval(Base64.decode64('${nativeRaceSource.toString("base64")}'), 'team-admin-race-native.rb')
       ENV['WASALX_ADMIN_TLS_TRUST_MODE'] = 'trusted'
       Module.new.module_eval(Base64.decode64('${nativeTlsSource.toString("base64")}'), 'mailbox-driver-tls-native.rb')`);
    assert.match(nativeOutput, /"fixture":"owner-service-initialize"/);
    assert.match(nativeOutput, /"fixture":"fresh-service-identity"/);
    const nativeInitializeProof = JSON.parse(nativeOutput.split("\n").find(line => line.startsWith('{"fixture":"owner-service-initialize"')) ?? "");
    const nativeFreshProof = JSON.parse(nativeOutput.split("\n").find(line => line.startsWith('{"fixture":"fresh-service-identity"')) ?? "");
    for (const proof of [nativeInitializeProof, nativeFreshProof])
      for (const [key, value] of Object.entries(proof)) if (key !== "fixture") assert.equal(value, true, key);

    assert.match(nativeOutput, /Service identity two-connection cancellation race passed; committed fixture cleaned\./);
    assert.match(nativeOutput, /Team administration native regression passed; fixture changes rolled back\./);
    assert.match(nativeOutput, /Team administration two-connection grant race passed; committed fixture cleaned\./);
    assert.match(nativeOutput, /Mailbox administration TLS\/native regression passed; database fixture rolled back\./);
    const trustedTls = JSON.parse(nativeOutput.split("\n").find(line => line.startsWith('{"mode":"SIMULATED","boundary":"NATIVE_MAILBOX_TLS"')) ?? "");
    assert.equal(trustedTls.trust_mode, "trusted");
    assert.equal(trustedTls.check_count, 10);
    assert.ok(trustedTls.proof.every(row => row.result === "PASS"));
    const untrustedOutput = await privateNative("run", "--rm", "--no-deps", "--env", "WASALX_ADMIN_TLS_TRUST_MODE=untrusted",
      "--env", "SSL_CERT_FILE=/run/wasalx-mailbox-fixture/untrusted-ca.crt", "zammad-package", "bundle", "exec", "rails", "runner",
      `require 'base64'; saved = JSON.parse(File.read('/var/tmp/portal-workspace-fixture.json'))
       ENV['WASALX_ADMIN_TEST_OWNER'] = WasalxMembership.find(saved.fetch('owner')).portal_user_id
       Module.new.module_eval(Base64.decode64('${nativeTlsSource.toString("base64")}'), 'mailbox-driver-tls-native.rb')`);
    const untrustedTls = JSON.parse(untrustedOutput.split("\n").find(line => line.startsWith('{"mode":"SIMULATED","boundary":"NATIVE_MAILBOX_TLS"')) ?? "");
    assert.equal(untrustedTls.trust_mode, "untrusted");
    assert.equal(untrustedTls.check_count, 4);
    assert.ok(untrustedTls.proof.every(row => row.result === "PASS"));
    const nativeProof = JSON.parse(nativeOutput.split("\n").find(line => line.startsWith('{"mode":"isolated-native-diagnostic"')) ?? "");
    const expectedCommit = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" }).trim();
    const expectedTree = execFileSync("git", ["rev-parse", `${expectedCommit}^{tree}`], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" }).trim();
    const catalog = JSON.parse(await readFile(join(process.cwd(), requiredOperatorInput("WASALX_IMAGE_CATALOG")), "utf8"));
    assert.equal(nativeProof.source.candidate_commit_sha, expectedCommit);
    assert.equal(nativeProof.source.candidate_tree_sha, expectedTree);
    assert.equal(nativeProof.source.native_package_sha256, catalog.tenantProvisioning.package.sha256);
    assert.equal(nativeProof.source.package_version, catalog.tenantProvisioning.package.version);
    assert.deepEqual(nativeProof.failures, []);
    await writeFile(join(evidenceDirectory, "portal-service-identity.json"), JSON.stringify({ evidenceMode: "simulated", image, source: nativeProof.source,
      ownerConversion: nativeInitializeProof, fresh: nativeFreshProof, cancellationRace: { independentConnections: true, cancelFirstFenced: true, admittedEffectPreserved: true,
        assertion: "Service identity two-connection cancellation race passed; committed fixture cleaned." } }, null, 2));
    assert.deepEqual(soleGroupProof.source, nativeProof.source);
    assert.deepEqual([...nativeProof.proof].sort(), [
      "native-team-read-write-and-channel-boundaries",
      "article-and-attachment-authorization",
      "native-receipt-replay-conflict-and-terminal-cancellation",
      "native-public-article-callback-and-single-delivery-admission",
      "postgres-concurrent-replay-and-stale-version-fence",
      "native-email-reply-and-unsupported-channel-in-email-team",
      "native-assignment-state-and-ineligible-owner",
      "native-handoff-and-internal-note-boundaries",
      "native-effect-and-receipt-rollback",
      "native-shared-group-workflow-and-read-only-replay",
      "native-ticket-create-options-idempotency-and-absence-fence",
      "native-ticket-create-cancel-race-and-receipt-rollback",
      "native-ticket-transfer-create-workflow-and-email-driver",
      "native-full-article-text-bounds-version-and-policy",
      "native-ticket-upload-ownership-target-and-selected-set",
      "native-group-receipt-fences-races-and-savepoints",
      "native-binary-staging-target-ownership-and-idempotent-retry",
      "native-portal-preview-reuses-route-and-does-not-admit-effects",
      "native-portal-cache-one-hour-expiry-and-scoped-cleanup",
      "native-inline-customer-create-reuse-and-identity-boundaries",
      "native-inline-customer-uniqueness-savepoint-and-receipt-rollback",
      "native-inline-customer-create-workflow-is-enforced",
      "native-privileged-expiry-after-lock-retains-true-denials",
      "current-membership-and-assurance-denials",
      "native-backend-health-has-no-operator-content",
      "wasalx-mail-default-reconciliation-preserves-native-contract",
      "wasalx-mail-links-through-native-renderer",
      "native-mailbox-administration-tls",
      "privacy-exact-friendly-target-current-native-policy-and-selection-race",
    ].sort());
    for (const tlsProof of [trustedTls, untrustedTls]) {
      assert.deepEqual(tlsProof.source, nativeProof.source);
      await writeFile(join(evidenceDirectory, `portal-native-mail-tls-${tlsProof.trust_mode}.json`), JSON.stringify({ evidenceMode: "simulated", image,
        ...tlsProof, testSha256: createHash("sha256").update(nativeTlsSource).digest("hex"), certificates: mailboxFixture.certificates.map(({ name, fingerprint256, validTo }) => ({ name, fingerprint256, validTo })) }, null, 2));
    }
    await writeFile(join(evidenceDirectory, "portal-native-administration.json"), JSON.stringify({ evidenceMode: "simulated", image, source: nativeProof.source,
      proof: ["native-team-administration", "native-two-connection-grant-cas", "native-mailbox-administration-tls"],
      tests: [nativeTeamSource, nativeRaceSource, nativeMailboxSource].map(source => createHash("sha256").update(source).digest("hex")) }, null, 2));
    await writeFile(join(evidenceDirectory, "portal-native-workspace.json"), JSON.stringify({
      evidenceMode: "simulated", image, ...nativeProof,
      testSha256: createHash("sha256").update(nativeSource).digest("hex"),
    }, null, 2));
  } catch (error) {
    primaryError = error;
  } finally {
    await settleNativeCompatibility({ project, directory, runnerContainer, runnerConnected, primaryError,
      closeBrowser: async () => { if (browser) await browser.close(); },
      closeFixture: async () => { if (fixture) await new Promise((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve())); },
      command: (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024,
        env: { ...process.env, WASALX_ZAMMAD_TEST_IMAGE: image }, stdio: ["ignore", "pipe", "pipe"] }),
      removeWorkspace: () => rm(directory, { recursive: true, force: true }),
      writeDiagnostics: async (value) => {
        const diagnostics = JSON.stringify(value, null, 2);
        await writeFile(join(directory, "cleanup-diagnostics.json"), diagnostics, { mode: 0o600 });
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(join(evidenceDirectory, "cleanup-diagnostics.json"), diagnostics, { mode: 0o600 });
      },
    });
  }
});
