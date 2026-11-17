import assert from "node:assert/strict";
import {
  boundedJsonRequest,
  explicitBoolean,
  isMain,
  liveBaseUrl,
  opaqueDigest,
  required,
  writeEvidence,
} from "./live-common.mjs";

const GRAPH_VERSION = /^v\d{1,3}\.\d{1,3}$/u;
const META_ID = /^[A-Za-z0-9_-]{1,510}={0,2}$/u;

export async function runMetaGroupsContract({ env = process.env, fetchImpl = fetch } = {}) {
  const graphVersion = required(env, "META_GRAPH_VERSION");
  assert.match(graphVersion, GRAPH_VERSION, "META_GRAPH_VERSION must use the form vNN.N");
  const phoneNumberId = metaId(required(env, "META_PHONE_NUMBER_ID"), "phone-number ID");
  const token = required(env, "META_ACCESS_TOKEN");
  assert.ok(token.length >= 16 && token.length <= 4_096, "META_ACCESS_TOKEN has an invalid length");
  const allowNonProduction = explicitBoolean(env, "META_LIVE_ALLOW_NON_PRODUCTION");
  const baseUrl = liveBaseUrl(
    env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com",
    "META_GRAPH_BASE_URL",
    allowNonProduction,
  );
  if (!allowNonProduction) assert.equal(baseUrl.hostname, "graph.facebook.com", "Live Meta evidence must use graph.facebook.com");
  const request = (path, init = {}, query = {}) => {
    const url = new URL(`/${graphVersion}${path}`, baseUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return boundedJsonRequest(fetchImpl, url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    }, { label: "Meta Graph" });
  };

  const groups = [];
  let after;
  do {
    const value = await request(
      `/${encodeURIComponent(phoneNumberId)}/groups`,
      {},
      {
        fields: "id,subject,total_participant_count",
        limit: "100",
        ...(after ? { after } : {}),
      },
    );
    const page = record(value);
    assert.ok(Array.isArray(page.data), "Meta returned an invalid Groups collection");
    groups.push(...page.data);
    assert.ok(groups.length <= 10_000, "Meta group discovery exceeded the documented account bound");
    after = cursorAfter(page.paging);
  } while (after);

  const groupId = env.META_CONTRACT_GROUP_ID
    ? metaId(env.META_CONTRACT_GROUP_ID, "group ID")
    : undefined;
  if (groupId) assert.ok(groups.some((group) => record(group).id === groupId), "Configured Meta group was not discovered");

  let inviteLinkRead = "not-requested";
  if (groupId && explicitBoolean(env, "META_CONTRACT_READ_INVITE_LINK")) {
    const value = record(await request(`/${encodeURIComponent(groupId)}/invite_link`));
    assert.match(String(value.invite_link ?? ""), /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{8,256}$/u, "Meta returned an invalid invite link");
    inviteLinkRead = "passed";
  }

  let sentMessageDigest = null;
  if (explicitBoolean(env, "META_CONTRACT_ALLOW_SEND")) {
    assert.ok(groupId, "META_CONTRACT_GROUP_ID is required for send validation");
    const marker = `WasalX Meta contract ${new Date().toISOString()} ${crypto.randomUUID()}`;
    const value = record(await request(`/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "group",
        to: groupId,
        type: "text",
        text: { body: marker },
      }),
    }));
    const messages = Array.isArray(value.messages) ? value.messages : [];
    const messageId = record(messages[0]).id;
    assert.ok(typeof messageId === "string" && messageId.length > 0, "Meta send response did not contain a message ID");
    sentMessageDigest = opaqueDigest(messageId);
  }

  return {
    provider: "META_GROUPS",
    graph_version: graphVersion,
    eligibility_probe: "passed",
    groups: groups.length,
    selected_group_present: Boolean(groupId),
    invite_link_read: inviteLinkRead,
    send_test: sentMessageDigest ? "passed" : "not-requested",
    sent_message_sha256: sentMessageDigest,
    observed_at: new Date().toISOString(),
  };
}

function cursorAfter(value) {
  const after = record(record(value).cursors).after;
  if (after === undefined || after === null || after === "") return undefined;
  assert.ok(typeof after === "string" && after.length <= 2_048 && !hasControlCharacters(after), "Meta returned an invalid pagination cursor");
  return after;
}

function metaId(value, label) {
  assert.match(value, META_ID, `Meta ${label} is invalid`);
  return value;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

if (isMain(import.meta.url)) {
  writeEvidence(await runMetaGroupsContract());
}
