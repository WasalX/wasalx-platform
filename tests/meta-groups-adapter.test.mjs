import assert from "node:assert/strict";
import test from "node:test";
import {
  META_GROUPS_DOCUMENTATION_URL,
  MetaGroupsAdapter,
} from "../services/connector-worker/dist/packages/connectors/src/meta.js";
import { ProviderError } from "../services/connector-worker/dist/packages/connectors/src/types.js";
import { groupWorkspaceMediaCapabilities } from "../packages/core/dist/provider-media-capabilities.js";

const token = "meta-system-user-token-with-enough-entropy";
const connectionId = "connection-1";

function adapter(overrides = {}) {
  return new MetaGroupsAdapter({
    accessToken: token,
    graphVersion: "v24.0",
    baseUrl: "https://graph.test",
    phoneNumberIdFor: (actual) => {
      assert.equal(actual, connectionId);
      return "123456789";
    },
    wabaIdFor: () => "987654321",
    ...overrides,
  });
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("Meta Groups eligibility is proven by the provider collection and exposes documented constraints", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: new URL(String(input)), init };
    return json({ data: [], paging: { cursors: {} } });
  };
  try {
    const result = await adapter().checkGroupsCapability(connectionId);
    assert.equal(result.eligible, true);
    assert.equal(result.state, "AVAILABLE");
    assert.equal(result.evidence, "provider_probe");
    assert.equal(result.constraints.officialBusinessAccountRequired, true);
    assert.equal(result.constraints.inviteOnly, true);
    assert.equal(result.constraints.maxParticipants, 8);
    assert.equal(result.constraints.maxGroupsPerNumber, 10_000);
    assert.equal(result.documentationUrl, META_GROUPS_DOCUMENTATION_URL);
    assert.equal(request.url.pathname, "/v24.0/123456789/groups");
    assert.equal(request.url.searchParams.get("limit"), "1");
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.headers.authorization, `Bearer ${token}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta Groups eligibility fails closed and provider error bodies are not exposed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json({ error: { code: 10, message: "sensitive provider diagnostic" } }, 403);
  try {
    const result = await adapter().checkGroupsCapability(connectionId);
    assert.equal(result.eligible, false);
    assert.equal(result.state, "PERMISSION_REQUIRED");
    assert.equal(result.reasonCode, "META_PERMISSION_REQUIRED");
    assert.doesNotMatch(JSON.stringify(result), /sensitive provider diagnostic/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta group lifecycle uses the official create, invite, update, subscription, and list contracts", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, init, body });
    if (url.pathname.endsWith("/groups") && init.method === "POST") {
      return json({ messaging_product: "whatsapp", request_id: "request-create-1" });
    }
    if (url.pathname.endsWith("/invite_link") && init.method === "GET") {
      return json({ messaging_product: "whatsapp", invite_link: "https://chat.whatsapp.com/AbCdEf123456" });
    }
    if (url.pathname.endsWith("/invite_link") && init.method === "POST") {
      return json({ messaging_product: "whatsapp", invite_link: "https://chat.whatsapp.com/XyZ987654321" });
    }
    if (url.pathname.endsWith("/subscribed_apps")) {
      return init.method === "POST" ? json({ success: true }) : json({ data: [{ id: "meta-app-1" }] });
    }
    return json({ messaging_product: "whatsapp", success: true });
  };
  try {
    const client = adapter();
    assert.deepEqual(
      await client.createGroup(connectionId, {
        subject: "  Operations pod  ",
        description: " Client operations ",
        joinApprovalMode: "approval_required",
      }),
      { requestId: "request-create-1" },
    );
    assert.deepEqual(await client.getGroupInviteLink(connectionId, "group_1"), {
      inviteLink: "https://chat.whatsapp.com/AbCdEf123456",
    });
    assert.deepEqual(await client.resetGroupInviteLink(connectionId, "group_1"), {
      inviteLink: "https://chat.whatsapp.com/XyZ987654321",
    });
    assert.deepEqual(await client.updateGroup(connectionId, "group_1", { subject: "Escalations" }), {
      updated: true,
    });
    assert.deepEqual(await client.subscribeWaba(connectionId), { subscribed: true });

    const create = requests.find(({ url, init }) => url.pathname.endsWith("/groups") && init.method === "POST");
    assert.deepEqual(create.body, {
      messaging_product: "whatsapp",
      subject: "Operations pod",
      description: "Client operations",
      join_approval_mode: "approval_required",
    });
    assert.equal(requests.find(({ url }) => url.pathname.endsWith("/subscribed_apps")).url.pathname, "/v24.0/987654321/subscribed_apps");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta WABA subscription accepts the authoritative successful mutation without a stale read-after-write", async () => {
  const originalFetch = globalThis.fetch;
  const requests=[];
  globalThis.fetch = async (input, init) => {requests.push({url:String(input),method:init.method});return json({ success: true })};
  try {
    assert.deepEqual(await adapter().subscribeWaba(connectionId),{subscribed:true});
    assert.equal(requests.length,1);assert.equal(requests[0].method,"POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta WABA subscription reconciles a permission error only for the token's already subscribed app", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    for (const subscribedAppId of ["app-ours", "app-other"]) {
      calls.length = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init.method} ${url.pathname}`);
        if (init.method === "POST") return json({ error: { code: 200, type: "OAuthException" } }, 403);
        if (url.pathname.endsWith("/app")) return json({ id: "app-ours" });
        return json({ data: [{ whatsapp_business_api_data: { id: subscribedAppId } }] });
      };
      if (subscribedAppId === "app-ours") {
        assert.deepEqual(await adapter().subscribeWaba(connectionId), { subscribed: true });
      } else {
        await assert.rejects(adapter().subscribeWaba(connectionId), (error) =>
          error instanceof ProviderError && error.code === "META_PERMISSION_REQUIRED");
      }
      assert.deepEqual(calls, [
        "POST /v24.0/987654321/subscribed_apps",
        "GET /v24.0/app",
        "GET /v24.0/987654321/subscribed_apps",
      ]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta group pages are validated and preserve opaque Graph cursors", async () => {
  const originalFetch = globalThis.fetch;
  let seenCursor;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    seenCursor = url.searchParams.get("after");
    return json({
      data: [{ id: "group_1", subject: "Operations", total_participant_count: 7 }],
      paging: { cursors: { after: "cursor-next" }, next: "https://graph.test/next" },
    });
  };
  try {
    const result = await adapter().listGroups(connectionId, "cursor-current");
    assert.equal(seenCursor, "cursor-current");
    assert.deepEqual(result, {
      groups: [{ id: "group_1", name: "Operations", participants: 7, suspended: false }],
      nextCursor: "cursor-next",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta webhook normalization supports official group text and authenticated media references", async () => {
  const client = adapter();
  const textMessage = await client.normalizeWebhook(connectionId, {
    entry: [{ changes: [{ value: { messages: [{
      id: "wamid.text",
      type: "text",
      group_id: "group_1",
      from: "12025550102",
      timestamp: "1786230000",
      text: { body: "ABC1234567" },
      context: { id: "wamid.quoted" },
    }] } }] }],
  }, new Headers());
  assert.equal(textMessage?.groupId, "group_1");
  assert.equal(textMessage?.quotedMessageId, "wamid.quoted");
  assert.equal(textMessage?.text, "ABC1234567");

  const mediaMessage = await client.normalizeWebhook(connectionId, {
    entry: [{ changes: [{ value: { messages: [{
      id: "wamid.media",
      type: "document",
      group_id: "group_1",
      from: "12025550102",
      timestamp: "1786230001",
      document: { id: "media_1", mime_type: "application/pdf", filename: "case.pdf", caption: "ABC1234567" },
    }] } }] }],
  }, new Headers());
  assert.equal(mediaMessage?.media?.url, "meta-media://media_1");
  assert.equal(mediaMessage?.media?.type, "document");
  assert.equal(mediaMessage?.text, "ABC1234567");
});

test("Meta webhook normalization keeps non-text group content transcript-safe", async () => {
  const client = adapter();
  const normalize = (message, contacts) => client.normalizeWebhook(connectionId, {
    entry: [{ changes: [{ value: { messages: [message], ...(contacts ? { contacts } : {}) } }] }],
  }, new Headers());
  const base = { group_id: "group_1", from: "12025550102", timestamp: "1786230000" };

  const contact = await normalize({ ...base, id: "wamid.contact", type: "contacts", contacts: [{ name: { first_name: "Test", last_name: "Contact" }, phones: [{ wa_id: "12025550120" }] }] }, [{ profile: { name: "Group Member" }, wa_id: "12025550102" }]);
  assert.equal(contact?.participantName, "Group Member");
  assert.equal(contact?.text, "Shared contact\nName: Test Contact\nPhone: 12025550120");

  const sticker = await normalize({ ...base, id: "wamid.sticker", type: "sticker", sticker: { id: "sticker_1", mime_type: "image/webp" } });
  assert.equal(sticker?.text, "Sticker");
  assert.deepEqual(sticker?.media, { type: "image", url: "meta-media://sticker_1", mimeType: "image/webp", isSticker: true });

  const location = await normalize({ ...base, id: "wamid.location", type: "location", location: { latitude: 24.7, longitude: 46.7, name: "Office", address: "Riyadh" } });
  assert.equal(location?.text, "Shared location\nName: Office\nAddress: Riyadh\nCoordinates: 24.7, 46.7");

  const reaction = await normalize({ ...base, id: "wamid.reaction", type: "reaction", reaction: { message_id: "wamid.original", emoji: "✅" } });
  assert.equal(reaction?.text, "Reacted with ✅");
  assert.equal(reaction?.eventKind, "REACTION");
  assert.equal(reaction?.quotedMessageId, "wamid.original");

  const choice = await normalize({ ...base, id: "wamid.choice", type: "interactive", interactive: { list_reply: { id: "status", title: "Shipment status" } } });
  assert.equal(choice?.text, "Shipment status");

  const unsupported = await normalize({ ...base, id: "wamid.unknown", type: "unknown", errors: [{ code: 130501 }] });
  assert.equal(unsupported?.text, "This WhatsApp message type is not supported yet.");
});

test("Meta message mutation never retries an ambiguous provider outcome", async (t) => {
  const originalFetch = globalThis.fetch;
  try {
    await t.test("network failure", async () => {
      globalThis.fetch = async () => { throw new TypeError("network reset"); };
      await assert.rejects(
        () => adapter().send({ connectionId, groupId: "group_1", text: "hello", idempotencyKey: "idem-1" }),
        (error) => error instanceof ProviderError && error.retryable && !error.outcomeKnown && error.code === "META_NETWORK",
      );
    });
    await t.test("retryable HTTP response", async () => {
      globalThis.fetch = async () => json({ error: { code: 613 } }, 429);
      await assert.rejects(
        () => adapter().send({ connectionId, groupId: "group_1", text: "hello", idempotencyKey: "idem-2" }),
        (error) => error instanceof ProviderError && error.retryable && !error.outcomeKnown && error.code === "META_RATE_LIMITED",
      );
    });
    await t.test("Graph rate limit remains retryable when Meta uses HTTP 400", async () => {
      globalThis.fetch = async () => json({ error: { code: 613 } }, 400);
      await assert.rejects(
        () => adapter().send({ connectionId, groupId: "group_1", text: "hello", idempotencyKey: "idem-graph-rate" }),
        (error) => error instanceof ProviderError && error.retryable && !error.outcomeKnown && error.code === "META_RATE_LIMITED",
      );
    });
    await t.test("non-retryable rejection is known not to have committed", async () => {
      globalThis.fetch = async () => json({ error: { code: 100, message: "Invalid parameter" } }, 400);
      await assert.rejects(
        () => adapter().send({ connectionId, groupId: "group_1", text: "hello", idempotencyKey: "idem-known-4xx" }),
        (error) => error instanceof ProviderError && !error.retryable && error.outcomeKnown && error.code === "META_GROUPS_UNAVAILABLE",
      );
    });
    for (const [name, body] of [
      ["empty object", {}], ["array", []], ["missing message", { error: { code: 100 } }],
      ["non-string message", { error: { code: 100, message: 42 } }],
      ["empty message", { error: { code: 100, message: "" } }],
      ["oversized message", { error: { code: 100, message: "x".repeat(4097) } }],
      ["control in message", { error: { code: 100, message: "invalid\nparameter" } }],
      ["string code", { error: { code: "100", message: "Invalid parameter" } }],
    ]) {
      await t.test(`non-concrete HTTP rejection remains unknown: ${name}`, async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls += 1; return json(body, 400); };
        await assert.rejects(
          () => adapter().send({ connectionId, groupId: "group_1", text: "hello", idempotencyKey: "idem-unknown-4xx" }),
          (error) => error instanceof ProviderError && !error.outcomeKnown,
        );
        assert.equal(calls, 1);
      });
    }
    await t.test("invalid successful response", async () => {
      globalThis.fetch = async () => json({ messages: [] });
      await assert.rejects(
        () => adapter().send({ connectionId, groupId: "group_1", text: "hello", idempotencyKey: "idem-3" }),
        (error) => error instanceof ProviderError && !error.retryable && !error.outcomeKnown && error.code === "META_INVALID_RESPONSE",
      );
    });
    await t.test("oversized successful response", async () => {
      globalThis.fetch = async () => json({ messages: [{ id: "wamid.1" }] }, 200, { "content-length": "2000000" });
      await assert.rejects(
        () => adapter().send({ connectionId, groupId: "group_1", text: "hello", idempotencyKey: "idem-4" }),
        (error) => error instanceof ProviderError && !error.outcomeKnown && error.code === "META_INVALID_RESPONSE",
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media upload is retry-safe and group delivery uses the returned media ID", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return url.pathname.endsWith("/media")
      ? json({ id: "media-upload-1" })
      : json({ messages: [{ id: "wamid.media.1" }] });
  };
  try {
    const client = adapter();
    const input = {
      connectionId,
      groupId: "group_1",
      text: "Evidence attached",
      idempotencyKey: "media-idem-1",
      media: {
        filename: "evidence.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      },
    };
    assert.deepEqual(await client.prepareMedia(input), { providerMediaId: "media-upload-1" });
    assert.ok(requests[0].init.body instanceof FormData);
    assert.equal(requests[0].init.body.get("messaging_product"), "whatsapp");
    assert.equal(requests[0].init.headers["content-type"], undefined);

    assert.deepEqual(
      await client.send({
        ...input,
        groupId: "Y2FwaV9ncm91cDoxMjM0NTY=",
        replyToMessageId: "wamid.HBgMNTU1MTIzNDU2FQIAERgSOD==",
        media: { ...input.media, providerMediaId: "media-upload-1" },
      }),
      { externalMessageId: "wamid.media.1", state: "SENT" },
    );
    const sendBody = JSON.parse(String(requests[1].init.body));
    assert.equal(sendBody.type, "document");
    assert.equal(sendBody.to, "Y2FwaV9ncm91cDoxMjM0NTY=");
    assert.equal(sendBody.context.message_id, "wamid.HBgMNTU1MTIzNDU2FQIAERgSOD==");
    assert.deepEqual(sendBody.document, {
      id: "media-upload-1",
      filename: "evidence.pdf",
      caption: "Evidence attached",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media upload accepts exactly the capabilities advertised to a group agent", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return json({ id: "media-upload-1" }); };
  try {
    const capabilities = groupWorkspaceMediaCapabilities("META");
    assert.equal(capabilities.voice_recording, false);
    assert.equal(capabilities.maximum_files, 10);
    assert.equal(capabilities.maximum_total_bytes, 250_000_000);
    assert.ok(capabilities.accepted.length > 0);
    for (const [index, item] of capabilities.accepted.entries()) {
      assert.deepEqual(await adapter().prepareMedia({
        connectionId,
        groupId: "group_1",
        text: "Evidence",
        idempotencyKey: `media-capability-${index}`,
        media: { filename: `evidence-${index}`, mimeType: item.mime_type, bytes: new Uint8Array([1]) },
      }), { providerMediaId: "media-upload-1" });
    }
    const rejected = [
      { filename: "voice.webm", mimeType: "audio/webm", bytes: new Uint8Array([1]) },
      { filename: "animation.gif", mimeType: "image/gif", bytes: new Uint8Array([1]) },
      { filename: "oversized.png", mimeType: "image/png", bytes: new Uint8Array(5 * 1024 * 1024 + 1) },
    ];
    for (const [index, media] of rejected.entries()) {
      await assert.rejects(
        () => adapter().prepareMedia({ connectionId, groupId: "group_1", text: "Evidence", idempotencyKey: `media-rejected-${index}`, media }),
        (error) => error instanceof ProviderError && !error.retryable && error.code === "META_MEDIA_INVALID",
      );
    }
    assert.equal(requests, capabilities.accepted.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media upload failures are retry-safe because upload alone cannot deliver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("connection reset"); };
  try {
    await assert.rejects(
      () => adapter().prepareMedia({
        connectionId,
        groupId: "group_1",
        text: "Evidence",
        idempotencyKey: "media-upload-retry",
        media: {
          filename: "evidence.pdf",
          mimeType: "application/pdf",
          bytes: new Uint8Array([1]),
        },
      }),
      (error) => error instanceof ProviderError && error.retryable && error.outcomeKnown && error.code === "META_NETWORK",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
