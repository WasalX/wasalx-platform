import assert from "node:assert/strict";
import {
  boundedJsonRequest,
  explicitBoolean,
  isMain,
  liveBaseUrl,
  opaqueDigest,
  readBoundedJsonFile,
  required,
  writeEvidence,
} from "./live-common.mjs";

const ENGINES = new Set(["GOWS", "NOWEB"]);
const MESSAGE_PAGE_LIMIT = 100;
const CONTRACT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export async function runWahaContract({ env = process.env, fetchImpl = fetch, restartSnapshot } = {}) {
  const baseUrl = liveBaseUrl(
    required(env, "WAHA_BASE_URL"),
    "WAHA_BASE_URL",
    explicitBoolean(env, "WAHA_LIVE_ALLOW_INSECURE"),
  );
  const apiKey = required(env, "WAHA_API_KEY");
  const session = required(env, "WAHA_SESSION");
  const expectedEngine = required(env, "WAHA_ENGINE").toUpperCase();
  assert.ok(ENGINES.has(expectedEngine), "WAHA_ENGINE must be GOWS or NOWEB");
  const request = (path, init = {}) =>
    boundedJsonRequest(fetchImpl, new URL(path, baseUrl), {
      ...init,
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    }, { label: "WAHA" });

  let state = await request(`/api/sessions/${encodeURIComponent(session)}`);
  assert.equal(record(state).status, "WORKING", "WAHA session must be WORKING");
  const observedEngine = sessionEngine(state);
  assert.equal(observedEngine, expectedEngine, "The live WAHA engine does not match WAHA_ENGINE");
  let identity = await request(`/api/sessions/${encodeURIComponent(session)}/me`);
  const identityId = identityIdentifier(identity);
  assert.ok(identityId, "Connected identity is missing");

  let groups = await discoverGroups(request, session);
  assert.ok(groups.length > 0, "No WhatsApp groups were discovered");
  const groupId = env.WAHA_CONTRACT_GROUP_ID;
  if (groupId) assert.ok(groups.some((group) => groupIdentifier(group) === groupId), "Configured contract group was not discovered");

  let messageEvidence = {
    recent: 0,
    participant_metadata: false,
    reply_metadata: false,
    media_metadata: false,
  };
  if (groupId) {
    const raw = await request(
      `/api/messages?chatId=${encodeURIComponent(groupId)}&limit=${MESSAGE_PAGE_LIMIT}&session=${encodeURIComponent(session)}`,
    );
    const messages = arrayPage(raw, "WAHA messages");
    messageEvidence = {
      recent: messages.length,
      participant_metadata: messages.some(hasParticipant),
      reply_metadata: messages.some(hasReply),
      media_metadata: messages.some(hasMediaMetadata),
    };
    if (explicitBoolean(env, "WAHA_CONTRACT_REQUIRE_MESSAGE_METADATA")) {
      assert.ok(messages.length > 0, "The contract group has no recent messages");
      assert.ok(messageEvidence.participant_metadata, "Participant metadata was not observed");
      assert.ok(messageEvidence.reply_metadata, "Quoted-message metadata was not observed");
      assert.ok(messageEvidence.media_metadata, "Media metadata was not observed");
    }
  }

  let sentMessageDigest = null;
  let sentMessageId = null;
  if (explicitBoolean(env, "WAHA_CONTRACT_ALLOW_SEND")) {
    assert.ok(groupId, "WAHA_CONTRACT_GROUP_ID is required for send validation");
    const marker = `WasalX contract ${new Date().toISOString()} ${crypto.randomUUID()}`;
    const sent = await request("/api/sendText", {
      method: "POST",
      body: JSON.stringify({
        session,
        chatId: groupId,
        text: marker,
        reply_to: env.WAHA_CONTRACT_REPLY_TO_MESSAGE_ID || undefined,
      }),
    });
    sentMessageId = messageIdentifier(sent);
    assert.ok(sentMessageId, "WAHA send response did not contain a message ID");
    await request(
      `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(sentMessageId)}?downloadMedia=false`,
    );
    sentMessageDigest = opaqueDigest(sentMessageId);
  }

  let editDelete = "not-requested";
  if (explicitBoolean(env, "WAHA_CONTRACT_ALLOW_EDIT_DELETE")) {
    assert.ok(groupId, "WAHA_CONTRACT_GROUP_ID is required for edit/delete validation");
    assert.ok(sentMessageId, "WAHA_CONTRACT_ALLOW_SEND=true is required for edit/delete validation");
    const editedMarker = `WasalX edited contract ${new Date().toISOString()} ${crypto.randomUUID()}`;
    const messagePath = `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(sentMessageId)}`;
    const edited = await request(messagePath, {
      method: "PUT",
      body: JSON.stringify({ text: editedMarker, linkPreview: false }),
    });
    // GOWS returns an edit protocol message and intentionally keeps the
    // original stored history row immutable. NOWEB/legacy engines may instead
    // expose the edited body on the original row. Prove the exact text from
    // either supported provider contract; never treat HTTP 200 alone as proof.
    if (!hasEditedProtocolText(edited, editedMarker)) {
      await waitForMessageBody(request, messagePath, editedMarker);
    }
    await request(messagePath, { method: "DELETE" });
    editDelete = "passed";
  }

  let mediaSend = "not-requested";
  let sentMediaDigest = null;
  if (explicitBoolean(env, "WAHA_CONTRACT_ALLOW_MEDIA_SEND")) {
    assert.ok(groupId, "WAHA_CONTRACT_GROUP_ID is required for media validation");
    const sent = await request("/api/sendImage", {
      method: "POST",
      body: JSON.stringify({
        session,
        chatId: groupId,
        caption: `WasalX media contract ${new Date().toISOString()} ${crypto.randomUUID()}`,
        file: {
          data: CONTRACT_PNG_BASE64,
          mimetype: "image/png",
          filename: "wasalx-contract.png",
        },
      }),
    });
    const mediaMessageId = messageIdentifier(sent);
    assert.ok(mediaMessageId, "WAHA media response did not contain a message ID");
    const observed = await request(
      `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(mediaMessageId)}?downloadMedia=false`,
    );
    assert.ok(hasMediaMetadata(observed), "WAHA media message was not readable with media metadata");
    mediaSend = "passed";
    sentMediaDigest = opaqueDigest(mediaMessageId);
  }

  let sessionRestart = "not-requested";
  let sessionRestartProviderSeconds = null;
  if (explicitBoolean(env, "WAHA_CONTRACT_ALLOW_SESSION_RESTART")) {
    const restartStartedAt = performance.now();
    await request(`/api/sessions/${encodeURIComponent(session)}/restart`, { method: "POST" });
    state = await waitForWorking(request, session);
    sessionRestartProviderSeconds = Number(((performance.now() - restartStartedAt) / 1_000).toFixed(3));
    assert.equal(sessionEngine(state), expectedEngine, "WAHA engine changed after session restart");
    identity = await request(`/api/sessions/${encodeURIComponent(session)}/me`);
    assert.equal(identityIdentifier(identity), identityId, "Connected identity changed after session restart");
    groups = await discoverGroups(request, session);
    if (groupId) assert.ok(groups.some((group) => groupIdentifier(group) === groupId), "Contract group disappeared after session restart");
    sessionRestart = "passed";
  }

  const snapshot = {
    schema: "wasalx-waha-restart-snapshot-v1",
    engine: expectedEngine,
    session_identity_sha256: opaqueDigest(identityId),
    session_name_sha256: opaqueDigest(session),
    selected_group_sha256: groupId ? opaqueDigest(groupId) : null,
    observed_at: new Date().toISOString(),
  };
  const priorSnapshot = restartSnapshot ??
    (env.WAHA_CONTRACT_RESTART_SNAPSHOT
      ? await readBoundedJsonFile(env.WAHA_CONTRACT_RESTART_SNAPSHOT)
      : undefined);
  let workerRestartRecovery = "not-requested";
  if (priorSnapshot !== undefined) {
    assertRestartSnapshot(priorSnapshot, snapshot);
    workerRestartRecovery = "passed";
  }

  return {
    provider: "WAHA",
    engine: expectedEngine,
    session_state: "WORKING",
    identity_present: true,
    groups: groups.length,
    ...messageEvidence,
    send_test: sentMessageDigest ? "passed" : "not-requested",
    sent_message_sha256: sentMessageDigest,
    edit_delete_test: editDelete,
    media_send_test: mediaSend,
    sent_media_sha256: sentMediaDigest,
    session_restart: sessionRestart,
    session_restart_provider_seconds: sessionRestartProviderSeconds,
    worker_restart_recovery: workerRestartRecovery,
    restart_snapshot: snapshot,
  };
}

async function discoverGroups(request, session) {
  const groups = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const raw = await request(`/api/${encodeURIComponent(session)}/groups?limit=100&offset=${offset}`);
    const page = arrayPage(raw, "WAHA groups");
    groups.push(...page);
    if (page.length < 100) return groups;
  }
  throw new Error("WAHA group discovery exceeded the 10,000-group contract bound");
}

async function waitForWorking(request, session) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await request(`/api/sessions/${encodeURIComponent(session)}`);
    const status = record(state).status;
    if (status === "WORKING") return state;
    if (status === "FAILED") throw new Error("WAHA session entered FAILED during restart");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("WAHA session did not return to WORKING within 60 seconds");
}

async function waitForMessageBody(request, messagePath, expectedBody) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = record(await request(`${messagePath}?downloadMedia=false`));
    if (value.body === expectedBody || value.text === expectedBody || value.caption === expectedBody) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("WAHA edited message was not readable with the expected body within 20 seconds");
}

function hasEditedProtocolText(value, expectedBody) {
  const source = record(value);
  if (source.body === expectedBody || source.text === expectedBody || source.caption === expectedBody) return true;
  const data = record(source._data);
  for (const container of [record(data.Message), record(data.RawMessage)]) {
    const edited = record(record(container.protocolMessage).editedMessage);
    if (record(edited.extendedTextMessage).text === expectedBody) return true;
    if (record(edited.imageMessage).caption === expectedBody) return true;
    if (record(edited.videoMessage).caption === expectedBody) return true;
    if (record(edited.documentMessage).caption === expectedBody) return true;
  }
  return false;
}

function sessionEngine(value) {
  const source = record(value);
  const engine = record(source.engine);
  const observed = engine.engine ?? engine.name ?? source.engine;
  if (typeof observed === "string") return observed.toUpperCase();
  // The pinned GOWS runtime reports structural engine evidence rather than a
  // label. Require `found=true`; mere presence of a caller-provided object is
  // not enough to satisfy the live gate.
  if (record(engine.gows).found === true) return "GOWS";
  return "";
}

function identityIdentifier(value) {
  const source = record(value);
  const nested = record(source.me);
  const candidate = source.id ?? nested.id;
  return typeof candidate === "string" && candidate ? candidate : null;
}

function groupIdentifier(value) {
  const source = record(value);
  // GOWS exposes the upstream Go model (`JID`), while NOWEB and older WAHA
  // releases expose `id`/`_serialized`. The live gate must prove the same
  // approved group against the actual pinned engine rather than silently
  // skipping GOWS records.
  const candidate = source.id ?? source._serialized ?? source.JID;
  return typeof candidate === "string" ? candidate : null;
}

function messageIdentifier(value) {
  const source = record(value);
  const key = record(source.key);
  const candidate = source.id ?? key.id;
  return typeof candidate === "string" && candidate ? candidate : null;
}

function hasParticipant(value) {
  const source = record(value);
  return [source.participant, source.author, record(source.key).participant]
    .some((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function hasReply(value) {
  const source = record(value);
  return Boolean(source.replyTo ?? source.reply_to ?? record(source._data).quotedMsg ?? record(source.context).id);
}

function hasMediaMetadata(value) {
  const source = record(value);
  return source.hasMedia === true || Boolean(source.media ?? source.mimetype ?? source.mimeType ?? source.mediaUrl);
}

function arrayPage(value, label) {
  if (Array.isArray(value)) return value;
  const data = record(value).data;
  if (Array.isArray(data)) return data;
  throw new Error(`${label} response is invalid`);
}

function assertRestartSnapshot(prior, current) {
  const source = record(prior);
  assert.equal(source.schema, current.schema, "Restart snapshot schema is invalid");
  assert.equal(source.engine, current.engine, "WAHA engine changed across worker restart");
  assert.equal(source.session_identity_sha256, current.session_identity_sha256, "Connected identity changed across worker restart");
  assert.equal(source.session_name_sha256, current.session_name_sha256, "Session changed across worker restart");
  assert.equal(source.selected_group_sha256 ?? null, current.selected_group_sha256, "Selected group changed across worker restart");
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

if (isMain(import.meta.url)) {
  writeEvidence(await runWahaContract());
}
