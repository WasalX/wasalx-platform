import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { InboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";
import {
  DefaultInboundMediaPipeline,
  MediaRuntimeError,
  MetaMediaDownloader,
  S3MediaStorage,
  WahaMediaDownloader,
  clamAvInstreamFrames,
  parseClamAvResponse,
} from "../services/connector-worker/dist/services/connector-worker/src/media-runtime.js";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const pngSha256 = createHash("sha256").update(png).digest("base64");

for (const stage of ["lookup", "optional-phone-retry", "download"]) {
  test(`Meta media rechecks current credentials before ${stage} without a network-error disguise`, async () => {
    const original = globalThis.fetch; let calls = 0; let checks = 0;
    const denied = new MediaRuntimeError("Credential changed", "META_CREDENTIAL_CONTEXT_CHANGED", false, false);
    globalThis.fetch = async () => {
      calls++;
      if (stage === "optional-phone-retry") return new Response(null, {status: 401});
      return Response.json({id:"media_guard",messaging_product:"whatsapp",url:"https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media_guard",mime_type:"image/png",sha256:pngSha256,file_size:png.length});
    };
    try {
      await assert.rejects(() => new MetaMediaDownloader("v24.0").download(
        {type:"image",url:"meta-media://media_guard",mimeType:"image/png"}, "synthetic-token", "15550001111",
        async () => { if (++checks === (stage === "lookup" ? 1 : 2)) throw denied; },
      ), error => error === denied);
      assert.equal(calls, stage === "lookup" ? 0 : 1);
      assert.equal(checks, stage === "lookup" ? 1 : 2);
    } finally { globalThis.fetch = original; }
  });
}

test("inbound media links persist the prepared safe filename and canonical object type",async()=>{
  const queries=[];
  const client={query:async(sql,values)=>{queries.push({sql,values});return{rowCount:sql.startsWith("UPDATE normalized_messages")?1:0,rows:[]}},release:()=>{}};
  const repository=new InboundRepository({connect:async()=>client});
  await repository.linkMediaObject(
    {id:"event-1",tenantId:"tenant-a",connectionId:"connection-1"},
    {messageId:"message-1"},
    "media-1","image.png","image/png",
  );
  const update=queries.find(({sql})=>sql.startsWith("UPDATE normalized_messages"));
  assert.match(update.sql,/jsonb_build_object\('media_object_id',\$1::text,'media_scan_state','CLEAN','fileName',\$2::text,'mimeType',\$3::text\)/u);
  assert.deepEqual(update.values,["media-1","image.png","image/png","tenant-a","event-1","connection-1","message-1"]);
});

test("WAHA media downloads stay on the private provider origin and authenticate only by header", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), headers: new Headers(init?.headers) };
    return new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
  };
  try {
    const downloader = new WahaMediaDownloader("http://waha-gows:3000");
    const downloaded = await downloader.download(
      { type: "image", url: "http://waha-gows:3000/api/files/proof", mimeType: "image/png", fileName: "proof.png" },
      "super-secret-api-key",
      "wx_generation_1",
    );
    assert.deepEqual(downloaded.bytes, png);
    assert.equal(request.headers.get("x-api-key"), "super-secret-api-key");
    assert.doesNotMatch(request.url, /super-secret-api-key/);
    await downloader.download(
      { type: "image", url: "http://localhost:3000/api/s3/proof", mimeType: "image/png", fileName: "proof.png" },
      "super-secret-api-key",
      "wx_generation_1",
      "http://waha-gows:3000",
    );
    assert.equal(request.url, "http://waha-gows:3000/api/s3/proof");
    for (const url of [
      "http://localhost:3000/api/files/proof",
      "http://localhost:3001/api/s3/proof",
      "https://localhost:3000/api/s3/proof",
    ]) {
      await assert.rejects(
        downloader.download(
          { type: "image", url, mimeType: "image/png" },
          "super-secret-api-key",
          "wx_generation_1",
          "http://waha-gows:3000",
        ),
        (error) => error instanceof MediaRuntimeError && error.code === "WAHA_MEDIA_ORIGIN" && !error.retryable,
      );
    }
    await assert.rejects(
      downloader.download(
        { type: "image", url: "https://attacker.example/proof", mimeType: "image/png" },
        "super-secret-api-key",
        "wx_generation_1",
      ),
      (error) => error instanceof MediaRuntimeError && error.code === "WAHA_MEDIA_ORIGIN" && !error.retryable,
    );
    assert.throws(() => new WahaMediaDownloader("https://waha.public.example"), /private origin/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WAHA media streaming enforces the bounded declared-type size even without Content-Length", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(15_000_001), { status: 200, headers: { "content-type": "image/png" } });
  try {
    const downloader = new WahaMediaDownloader("http://127.0.0.1:3000");
    await assert.rejects(
      downloader.download(
        { type: "image", url: "http://127.0.0.1:3000/api/files/too-large", mimeType: "image/png" },
        "key",
        "session",
      ),
      (error) => error instanceof MediaRuntimeError && error.code === "WAHA_MEDIA_SIZE" && error.quarantine,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media IDs are resolved and downloaded with one bearer token on the official Graph origin", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const request = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect };
    requests.push(request);
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        id: "media_1",
        messaging_product: "whatsapp",
        url: "https://graph.facebook.com/v24.0/media_1/content?hash=opaque",
        mime_type: "image/png",
        sha256: pngSha256,
        file_size: png.length,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(png, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    });
  };
  try {
    const downloaded = await new MetaMediaDownloader("v24.0").download(
      { type: "image", url: "meta-media://media_1", mimeType: "image/png", fileName: "proof.png" },
      "meta-access-token",
      "15550001111",
    );
    assert.deepEqual(downloaded, { bytes: png, mimeType: "image/png", filename: "proof.png" });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "https://graph.facebook.com/v24.0/media_1?phone_number_id=15550001111");
    assert.equal(requests[1].url, "https://graph.facebook.com/v24.0/media_1/content?hash=opaque");
    for (const request of requests) {
      assert.equal(request.headers.get("authorization"), "Bearer meta-access-token");
      assert.equal(request.redirect, "manual");
      assert.doesNotMatch(request.url, /meta-access-token/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media accepts the live hex digest and official lookaside download origin", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const request = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect };
    requests.push(request);
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        id: "media_live",
        messaging_product: "whatsapp",
        url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media_live&ext=1&hash=opaque",
        mime_type: "image/png",
        sha256: createHash("sha256").update(png).digest("hex"),
        file_size: png.length,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(png, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    });
  };
  try {
    const downloaded = await new MetaMediaDownloader("v24.0").download(
      { type: "image", url: "meta-media://media_live", mimeType: "image/png", fileName: "proof.png" },
      "meta-access-token",
      "15550001111",
    );
    assert.deepEqual(downloaded, { bytes: png, mimeType: "image/png", filename: "proof.png" });
    assert.equal(requests[1].url, "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media_live&ext=1&hash=opaque");
    assert.equal(requests[1].headers.get("authorization"), "Bearer meta-access-token");
    assert.equal(requests[1].redirect, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media retries without the optional phone ownership check for signed forwarded media", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const request = { url: String(input), headers: new Headers(init?.headers) };
    requests.push(request);
    if (requests.length === 1) return new Response(null, { status: 403 });
    if (requests.length === 2) {
      return new Response(JSON.stringify({
        id: "forwarded_sticker",
        messaging_product: "whatsapp",
        url: "https://graph.facebook.com/v24.0/forwarded_sticker/content?hash=opaque",
        mime_type: "image/webp",
        sha256: createHash("sha256").update(png).digest("hex"),
        file_size: png.length,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(png, {
      status: 200,
      headers: { "content-type": "image/webp", "content-length": String(png.length) },
    });
  };
  try {
    const downloaded = await new MetaMediaDownloader("v24.0").download(
      { type: "image", url: "meta-media://forwarded_sticker", mimeType: "image/webp" },
      "meta-access-token",
      "15550001111",
    );
    assert.equal(downloaded.mimeType, "image/webp");
    assert.equal(requests[0].url, "https://graph.facebook.com/v24.0/forwarded_sticker?phone_number_id=15550001111");
    assert.equal(requests[1].url, "https://graph.facebook.com/v24.0/forwarded_sticker");
    assert.equal(requests[2].url, "https://graph.facebook.com/v24.0/forwarded_sticker/content?hash=opaque");
    for (const request of requests) assert.equal(request.headers.get("authorization"), "Bearer meta-access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media rejects redirect, foreign-origin, type, size, and integrity substitution", async (t) => {
  const originalFetch = globalThis.fetch;
  const metadata = (overrides = {}) => ({
    id: "media_1",
    messaging_product: "whatsapp",
    url: "https://graph.facebook.com/v24.0/media_1/content?hash=opaque",
    mime_type: "image/png",
    sha256: pngSha256,
    file_size: png.length,
    ...overrides,
  });
  const lookup = (value, status = 200, headers = { "content-type": "application/json" }) =>
    new Response(typeof value === "string" ? value : JSON.stringify(value), { status, headers });
  try {
    await t.test("foreign resolved origin", async () => {
      globalThis.fetch = async () => lookup(metadata({ url: "https://attacker.example/media_1" }));
      await assert.rejects(
        () => new MetaMediaDownloader("v24.0").download({ type: "image", url: "meta-media://media_1", mimeType: "image/png" }, "token", "15550001111"),
        (error) => error instanceof MediaRuntimeError && error.code === "META_MEDIA_ORIGIN" && !error.retryable && error.quarantine,
      );
    });
    await t.test("lookup redirect", async () => {
      globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://attacker.example" } });
      await assert.rejects(
        () => new MetaMediaDownloader("v24.0").download({ type: "image", url: "meta-media://media_1", mimeType: "image/png" }, "token", "15550001111"),
        (error) => error instanceof MediaRuntimeError && error.code === "META_MEDIA_REDIRECT" && !error.retryable,
      );
    });
    await t.test("metadata MIME mismatch", async () => {
      globalThis.fetch = async () => lookup(metadata({ mime_type: "application/pdf" }));
      await assert.rejects(
        () => new MetaMediaDownloader("v24.0").download({ type: "image", url: "meta-media://media_1", mimeType: "image/png" }, "token", "15550001111"),
        (error) => error instanceof MediaRuntimeError && error.code === "META_MEDIA_TYPE_MISMATCH" && !error.retryable,
      );
    });
    await t.test("stream exceeds declared size", async () => {
      let call = 0;
      globalThis.fetch = async () => ++call === 1
        ? lookup(metadata())
        : new Response(Uint8Array.from([...png, 1]), { status: 200, headers: { "content-type": "image/png" } });
      await assert.rejects(
        () => new MetaMediaDownloader("v24.0").download({ type: "image", url: "meta-media://media_1", mimeType: "image/png" }, "token", "15550001111"),
        (error) => error instanceof MediaRuntimeError && error.code === "META_MEDIA_SIZE" && !error.retryable,
      );
    });
    await t.test("sha256 mismatch", async () => {
      let call = 0;
      globalThis.fetch = async () => ++call === 1
        ? lookup(metadata({ sha256: createHash("sha256").update("different").digest("base64") }))
        : new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      await assert.rejects(
        () => new MetaMediaDownloader("v24.0").download({ type: "image", url: "meta-media://media_1", mimeType: "image/png" }, "token", "15550001111"),
        (error) => error instanceof MediaRuntimeError && error.code === "META_MEDIA_INTEGRITY" && !error.retryable,
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Meta media HTTP outcomes distinguish retryable provider faults from terminal authorization failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(
      () => new MetaMediaDownloader("v24.0").download({ type: "image", url: "meta-media://media_1", mimeType: "image/png" }, "token", "15550001111"),
      (error) => error instanceof MediaRuntimeError && error.code === "META_MEDIA_LOOKUP_HTTP" && error.retryable && !error.quarantine,
    );
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(
      () => new MetaMediaDownloader("v24.0").download({ type: "image", url: "meta-media://media_1", mimeType: "image/png" }, "token", "15550001111"),
      (error) => error instanceof MediaRuntimeError && error.code === "META_MEDIA_AUTH" && !error.retryable && !error.quarantine,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the inbound Meta pipeline reuses tenant-scoped scan and private storage without issuing a media URL", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCall = 0;
  globalThis.fetch = async () => ++fetchCall === 1
    ? new Response(JSON.stringify({
        id: "media_tenant",
        messaging_product: "whatsapp",
        url: "https://graph.facebook.com/v24.0/media_tenant/content",
        mime_type: "image/png",
        sha256: pngSha256,
        file_size: png.length,
      }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
  const calls = [];
  const repository = {
    findByHash: async (tenantId) => { calls.push(`find:${tenantId}`); return null; },
    reserve: async (record) => { calls.push(`reserve:${record.tenantId}`); return {...record,scanState:"STAGING"}; },
    promote: async (record) => { calls.push(`promote:${record.tenantId}`); return record; },
  };
  const storage = {
    put: async (key, _bytes, metadata) => calls.push(`put:${key}:${metadata.tenant_id}`),
    signedUrl: async () => { throw new Error("inbound media must not issue a URL"); },
  };
  const scanner = { scan: async () => { calls.push("scan"); return { state: "CLEAN", engine: "clamav" }; } };
  const connectionId="20000000-0000-4000-8000-000000000002";
  const secrets = {
    resolve: async (reference,owner) => {
      assert.equal(reference, `secret://tenant-a/connections/${connectionId}/meta`);
      assert.deepEqual(owner,{kind:"meta-connection",tenantId:"tenant-a",connectionId});
      return { accessToken: "meta-access-token" };
    },
  };
  try {
    const pipeline = new DefaultInboundMediaPipeline(
      secrets,
      new WahaMediaDownloader(),
      new MetaMediaDownloader("v24.0"),
      scanner,
      storage,
      repository,
    );
    const result = await pipeline.prepare({
      tenantId: "tenant-a",
      connectionId,
      provider: "meta",
      connectionSecretReference: `secret://tenant-a/connections/${connectionId}/meta`,
      providerSessionId: "15550001111",
      beforeMetaRequest: async token => { assert.equal(token, "meta-access-token"); },
      retentionDays: 30,
      media: { type: "image", url: "meta-media://media_tenant", mimeType: "image/png", fileName: "proof.png" },
    });
    assert.equal(result.attachment.data, Buffer.from(png).toString("base64"));
    assert.equal(result.attachment["mime-type"], "image/png");
    assert.deepEqual(calls.slice(0, 2), ["find:tenant-a", "scan"]);
    assert.equal(calls[2],"reserve:tenant-a");
    assert.match(calls[3], /^put:tenant-a\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}:tenant-a$/);
    assert.equal(calls[4], "promote:tenant-a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private object storage signs requests, requires server-side encryption, and never places its secret in URLs", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), headers: new Headers(init?.headers), method: init?.method, redirect: init?.redirect };
    return new Response(null, { status: 200 });
  };
  try {
    const storage = new S3MediaStorage({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "wasalx-media",
      accessKeyId: "local-access",
      secretAccessKey: "never-in-a-url",
    });
    await storage.put("tenant/sha256/aa/digest", png, { mime_type: "image/png", tenant_id: "tenant" });
    assert.equal(request.method, "PUT");
    assert.equal(request.headers.get("x-amz-server-side-encryption"), "AES256");
    assert.equal(request.redirect, "error");
    assert.match(request.headers.get("authorization"), /^AWS4-HMAC-SHA256 /);
    assert.doesNotMatch(request.url, /never-in-a-url/);
    const signed = await storage.signedUrl("tenant/sha256/aa/digest", 300);
    assert.match(signed, /X-Amz-Signature=/);
    assert.doesNotMatch(signed, /never-in-a-url/);
    assert.deepEqual([...new URL(signed).searchParams.keys()], [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private object storage permits disabling server-side encryption only in explicit local environments", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), headers: new Headers(init?.headers), method: init?.method };
    return new Response(null, { status: 200 });
  };
  const config = {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "wasalx-media",
    accessKeyId: "local-access",
    secretAccessKey: "local-secret",
    serverSideEncryption: "NONE",
  };
  try {
    assert.throws(
      () => new S3MediaStorage({ ...config, environment: "production" }),
      /only in a local environment/u,
    );
    assert.throws(
      () => new S3MediaStorage({ ...config, environment: undefined }),
      /only in a local environment/u,
    );
    const storage = new S3MediaStorage({ ...config, endpoint: "http://minio:9000", environment: "local-full" });
    await storage.put("tenant/sha256/aa/digest", png, { mime_type: "image/png", tenant_id: "tenant" });
    assert.equal(request.method, "PUT");
    assert.equal(request.headers.get("x-amz-server-side-encryption"), null);
    assert.match(request.headers.get("authorization"), /^AWS4-HMAC-SHA256 /u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private object storage requires HTTPS and a KMS key in production", async () => {
  assert.throws(
    () => new S3MediaStorage({ endpoint: "http://s3.example.com", region: "us-east-1", bucket: "wasalx-media", accessKeyId: "key", secretAccessKey: "secret", environment: "production" }),
    /must use HTTPS/u,
  );
  assert.throws(
    () => new S3MediaStorage({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "wasalx-media", accessKeyId: "key", secretAccessKey: "secret", serverSideEncryption: "aws:kms", environment: "production" }),
    /KMS key identifier is required/u,
  );
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect };
    return new Response(null, { status: 200 });
  };
  try {
    const storage = new S3MediaStorage({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "wasalx-media", accessKeyId: "key", secretAccessKey: "secret", serverSideEncryption: "aws:kms", kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/test", environment: "production" });
    await storage.put("tenant/sha256/aa/digest", png, { mime_type: "image/png" });
    assert.equal(request.headers.get("x-amz-server-side-encryption"), "aws:kms");
    assert.equal(request.headers.get("x-amz-server-side-encryption-aws-kms-key-id"), "arn:aws:kms:us-east-1:111122223333:key/test");
    assert.equal(request.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private object storage supports provider-managed encryption without unsupported SSE headers", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect };
    return new Response(null, { status: 200 });
  };
  try {
    const storage = new S3MediaStorage({ endpoint: "https://managed-storage.example.com", region: "auto", bucket: "wasalx-media", accessKeyId: "key", secretAccessKey: "secret", serverSideEncryption: "MANAGED", environment: "production" });
    await storage.put("tenant/sha256/aa/digest", png, { mime_type: "image/png" });
    assert.equal(request.headers.get("x-amz-server-side-encryption"), null);
    assert.equal(request.headers.get("x-amz-server-side-encryption-aws-kms-key-id"), null);
    assert.equal(request.redirect, "error");
    assert.throws(
      () => new S3MediaStorage({ endpoint: "https://managed-storage.example.com", region: "auto", bucket: "wasalx-media", accessKeyId: "key", secretAccessKey: "secret", serverSideEncryption: "MANAGED", kmsKeyId: "unexpected", environment: "production" }),
      /requires KMS encryption/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ClamAV protocol framing is bounded and clean/infected outcomes are parsed without leaking scanner text", () => {
  const frames = clamAvInstreamFrames(png);
  assert.equal(Buffer.from(frames[0]).toString(), "zINSTREAM\0");
  assert.equal(Buffer.from(frames[1]).readUInt32BE(), png.length);
  assert.deepEqual(frames[2], png);
  assert.equal(Buffer.from(frames.at(-1)).readUInt32BE(), 0);
  assert.deepEqual(parseClamAvResponse("stream: OK\0"), { state: "CLEAN", engine: "clamav" });
  assert.deepEqual(parseClamAvResponse("stream: Eicar-Test-Signature FOUND\0"), {
    state: "INFECTED",
    engine: "clamav",
    signature: "Eicar-Test-Signature",
  });
  assert.deepEqual(parseClamAvResponse("stream: scanner internal detail ERROR\0"), { state: "ERROR", engine: "clamav" });
});

test("inbound media is prepared once, linked in control-plane metadata, and reused across identifier tickets", async () => {
  const event = {
    id: "event-media",
    tenantId: "tenant-a",
    connectionId: "c1",
    provider: "waha",
    providerEventId: "evt-media",
    eventType: "message",
    attempts: 1,
    payload: {
      id: "evt-media",
      event: "message",
      payload: {
        id: "message-media",
        chatId: "447700900001@g.us",
        participant: "12025550120@c.us",
        body: "Cases 1234567890 and 0987654321",
        timestamp: 1_700_000_000,
        media: { url: "http://waha/api/files/proof", mimetype: "image/png", filename: "proof.png" },
      },
    },
  };
  const context = {
    bindingId: "binding-1",
    groupId: "447700900001@g.us",
    zammadGroup: "Operations",
    acknowledgementTemplate: "Cases {{tickets}}",
    maxIdentifiers: 20,
    agentPrefix: "Agent",
    ruleVersion: 1,
    zammadBaseUrl: "https://zammad.example",
    zammadSecretReference: "secret://zammad",
    connectionSecretReference: "secret://waha",
    providerBaseUrl: "http://waha.internal:3000/",
    providerSessionId: "wx_generation_1",
    wahaWorkerId: "30000000-0000-4000-8000-000000000001",
    wahaAssignmentFencingToken: 7,
    mediaEnabled: true,
    retentionDays: 30,
    rules: [{ id: "r", name: "IDs", matcherType: "exact_length", pattern: "", prefix: null, digitLength: 10, priority: 1, enabled: true, version: 1 }],
  };
  const calls = [];
  const repository = {
    claim: async () => [event],
    messageIsWithinAdmissionWindow: async () => true,
    context: async () => context,
    renewWahaWorkerAssignment: async (_event, actual) => { assert.equal(actual.wahaAssignmentFencingToken, 7); calls.push("assignment-renew"); return actual; },
    ticketsForQuotedMessage: async () => [],
    normalize: async () => "new",
    linkMediaObject: async (_event, _message, id, filename, mimeType) => calls.push(`media-link:${id}:${filename}:${mimeType}`),
    linkZammadCustomer: async (_event, _message, customer) => calls.push(`customer-link:${customer.id}`),
    correlate: async (_event, _context, _message, reference, actions) => actions.create(`key:${reference}`),
    enqueueAcknowledgement: async () => "delivery",
    complete: async (_event, _lease, status, redact) => calls.push(`complete:${status}:${redact}`),
    fail: async (_event, _lease, retryable, error) => { throw new Error(`unexpected failure ${retryable}:${error}`); },
  };
  const media = {
    prepare: async () => {
      calls.push("media-prepare");
      return { mediaObjectId: "media-1", deduplicated: false, attachment: { filename: "proof.png", data: "cG5n", "mime-type": "image/png" } };
    },
  };
  const originalFetch = globalThis.fetch;
  let nextTicket = 40;
  const attachments = [];
  const articlePreferences = [];
  const customerPayloads = [];
  const articleOriginIds = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/users/search")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/v1/users") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      customerPayloads.push(body);
      return new Response(JSON.stringify({ id: 7, login: body.login, firstname: body.firstname, lastname: "", email: "", mobile: body.mobile }), { status: 201 });
    }
    if (url.includes("/tickets/search")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith("/api/v1/tickets") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      attachments.push(body.article.attachments);
      articlePreferences.push(body.article.preferences);
      articleOriginIds.push(body.article.origin_by_id);
      nextTicket += 1;
      return new Response(JSON.stringify({ id: nextTicket, number: String(10_000 + nextTicket), state: "open", group: "Operations", title: "Case" }), { status: 200 });
    }
    if (url.includes("/api/v1/ticket_articles/by_ticket/")) {
      return Response.json([{ id: Number(url.split("/").at(-1)), preferences: { wasalx_external_message_id: "message-media" } }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const processor = new InboundProcessor(repository, { resolve: async () => ({ token: "zammad-token" }) }, media);
    assert.deepEqual(await processor.drainTenant("tenant-a"), { events: 1, acknowledgements: 1 });
    assert.deepEqual(calls, ["assignment-renew", "media-prepare", "media-link:media-1:proof.png:image/png", "customer-link:7", "complete:PROCESSED:false"]);
    assert.equal(attachments.length, 2);
    assert.deepEqual(attachments[0], attachments[1]);
    assert.deepEqual(articlePreferences, [
      { wasalx_origin: "provider", wasalx_external_message_id: "message-media", wasalx_sender_phone: "+12025550120" },
      { wasalx_origin: "provider", wasalx_external_message_id: "message-media", wasalx_sender_phone: "+12025550120" },
    ]);
    assert.equal(customerPayloads[0].mobile, "+12025550120");
    assert.deepEqual(articleOriginIds, [7, 7]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminal media validation quarantines and redacts the event before any Zammad call", async () => {
  const event = {
    id: "event-bad-media",
    tenantId: "tenant-a",
    connectionId: "c1",
    provider: "waha",
    providerEventId: "evt-bad-media",
    eventType: "message",
    attempts: 1,
    payload: { event: "message", payload: { id: "m", chatId: "447700900003@g.us", participant: "p", body: "1234567890", timestamp: 1_700_000_000, media: { url: "http://waha/file", mimetype: "image/png" } } },
  };
  const calls = [];
  const repository = {
    claim: async () => [event],
    messageIsWithinAdmissionWindow: async () => true,
    context: async () => ({ bindingId: "b", groupId: "447700900003@g.us", zammadGroup: "Ops", acknowledgementTemplate: "{{tickets}}", maxIdentifiers: 20, agentPrefix: "Agent", ruleVersion: 1, zammadBaseUrl: "https://zammad", zammadSecretReference: "secret://z", connectionSecretReference: "secret://w", providerBaseUrl: "http://waha.internal:3000/", providerSessionId: "s", wahaWorkerId: "30000000-0000-4000-8000-000000000001", wahaAssignmentFencingToken: 7, mediaEnabled: true, retentionDays: 30, rules: [{ id: "r", name: "id", matcherType: "exact_length", pattern: "", prefix: null, digitLength: 10, priority: 1, enabled: true, version: 1 }] }),
    renewWahaWorkerAssignment: async (_event, context) => context,
    ticketsForQuotedMessage: async () => [],
    normalize: async () => "new",
    quarantineInbound: async (_event, input) => calls.push({ quarantine: input.reasonCode }),
    complete: async (_event, _lease, status, redact, safeError) => calls.push({ status, redact, safeError }),
    fail: async () => { throw new Error("must not fail a quarantined event"); },
  };
  const processor = new InboundProcessor(
    repository,
    { resolve: async () => { throw new Error("must not resolve Zammad"); } },
    { prepare: async () => { throw new MediaRuntimeError("MIME mismatch", "MIME_MISMATCH", false); } },
  );
  assert.deepEqual(await processor.drainTenant("tenant-a"), { events: 1, acknowledgements: 0 });
  assert.deepEqual(calls, [
    { quarantine: "MEDIA_TYPE_UNSAFE" },
    { status: "QUARANTINED", redact: true, safeError: "MIME_MISMATCH" },
  ]);
});

test("opted-in group history stages media even when no ticket rule matches",async()=>{
  const event={id:"event-history-media",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-history-media",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"history-media",chatId:"447700900003@g.us",participant:"p",body:"holiday photo",timestamp:1_700_000_000,media:{url:"http://waha/file",mimetype:"image/png",filename:"photo.png"}}}};
  const calls=[];const repository={claim:async()=>[event],messageIsWithinAdmissionWindow:async()=>true,normalize:async()=>"new",context:async()=>null,hasRunnableGroupBinding:async()=>false,workspaceMediaContext:async()=>({connectionSecretReference:"secret://w",providerBaseUrl:"http://waha.internal:3000/",providerSessionId:"s",wahaWorkerId:"30000000-0000-4000-8000-000000000001",wahaAssignmentFencingToken:7,mediaEnabled:true,retentionDays:30}),renewWahaWorkerAssignment:async(_event,context)=>context,linkMediaObject:async(_event,_message,id,filename,mimeType)=>calls.push(`linked:${id}:${filename}:${mimeType}`),complete:async(_event,_lease,status)=>calls.push(status),fail:async()=>{throw new Error("must not fail")}};
  const processor=new InboundProcessor(repository,{resolve:async()=>({apiKey:"waha-key"})},{prepare:async()=>({attachment:{filename:"photo.png",data:"data","mime-type":"image/png"},mediaObjectId:"media-history",deduplicated:false})});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.deepEqual(calls,["linked:media-history:photo.png:image/png","UNMATCHED"]);
});

test("the repository revalidates the exact active Meta media credential context in a short tenant transaction",async()=>{
  const proof={credentialFingerprint:createHash("sha256").update("current-token").digest("hex")};
  const queries=[];
  let current=true;
  const client={query:async(sql,values)=>{
    queries.push({sql,values});
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config"))return{rows:[],rowCount:0};
    if(sql.includes("AS meta_account_proof"))return{rows:current?[{meta_account_proof:proof}]:[],rowCount:current?1:0};
    throw new Error(`Unexpected Meta credential query: ${sql}`);
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={tenantId:"tenant-a",connectionId:"20000000-0000-4000-8000-000000000002"};
  const context={providerSessionId:"90000000-0000-4000-8000-000000000001",phoneNumberId:"15550001111",wabaId:"waba-1",proof};
  assert.equal(await repository.currentMetaCredentialProof(event,"secret://tenant-a/connections/meta",context),proof);
  const query=queries.find(({sql})=>sql.includes("AS meta_account_proof"));
  assert.ok(query);
  assert.doesNotMatch(query.sql,/FOR (?:NO KEY )?(?:SHARE|UPDATE)/u);
  assert.match(query.sql,/connection\.secret_reference=\$3/u);
  assert.match(query.sql,/session\.id=\$4::uuid/u);
  assert.match(query.sql,/session\.ownership_state='ACTIVE' AND session\.state='WORKING'/u);
  assert.match(query.sql,/IS NOT DISTINCT FROM \$6::text/u);
  assert.deepEqual(query.values,[event.tenantId,event.connectionId,"secret://tenant-a/connections/meta",context.providerSessionId,context.phoneNumberId,context.wabaId,JSON.stringify(proof),process.env.META_APP_ID??"",0]);
  current=false;
  await assert.rejects(()=>repository.currentMetaCredentialProof(event,"secret://tenant-a/connections/meta",context),/credential context changed/u);
});

for(const support of [false,true])test(`Meta group media keeps exact session proof with ${support?"support routing":"department assignment"}`,async()=>{
  const routing={schemaVersion:1,name:"Support routing",supportGroupIds:["7"],fallback:{zammadGroupId:"9",ownerId:"42"},sources:[{id:"manual",name:"Manual",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}}],clients:[]};
  const entryGroupId=support?"7":"2";
  const {applyMetaLifecycleObservation}=await import("../services/connector-worker/dist/packages/core/src/meta-account-relation.js");
  const lifecycle=applyMetaLifecycleObservation(undefined,{event:"ACCOUNT_OFFBOARDED",kind:"BLOCK",reasons:["ACCOUNT_OFFBOARDED"],observedAt:"2026-10-07T10:00:00.000Z",payloadSha256:"c".repeat(64)}).state;
  const proof={credentialFingerprint:"a".repeat(64),credentialMetadata:{claim:"CREDENTIAL_METADATA_VERIFIED",appId:"123456789",scopes:["whatsapp_business_management","whatsapp_business_messaging"],expiresAt:0,dataAccessExpiresAt:0,verifiedAt:"2026-10-07T12:00:00.000Z",responseSha256:"b".repeat(64)}};
  const identity={provider_session_id:"90000000-0000-4000-8000-000000000001",opaque_session_id:"15550001111",meta_waba_id:"waba-1",meta_account_proof:proof,meta_lifecycle:lifecycle,meta_lifecycle_present:true};
  const queries=[];
  const client={query:async(sql)=>{
    queries.push(sql);
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config")||sql.startsWith("WITH selected"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT b.id AS binding_id"))return{rows:[{...identity,participant_phone:null,binding_id:"binding-1",external_group_id:"group-1",group_name:"Support",connection_name:"Meta",connection_phone:null,zammad_group_id:entryGroupId,default_priority:"normal",assignment_mode:"group",fixed_owner_id:null,sla_policy_id:null,business_hours_mode:"always",business_hours_calendar_id:null,acknowledgement_template:"{{tickets}}",group_disclosure_enabled:false,group_disclosure_message:null,max_identifiers:20,agent_prefix:"Agent",media_enabled:true,retention_days:30,rule_set_id:"rule-set-1",rule_version:1,zammad_base_url:"https://zammad.example",zammad_secret_reference:"secret://zammad",connection_secret_reference:"secret://meta",provider_base_url:null,waha_worker_id:null,assignment_fencing_token:null,assignment_lease_expires_at:null,rule_id:null,rule_name:null,matcher_type:null,pattern:null,matcher_options:null,priority:null,enabled:null,client_routing_version_id:"routing-v1",client_routing_definition:routing}],rowCount:1};
    if(sql.includes("LEAST(workspace.retention_days"))return{rows:[{...identity,connection_secret_reference:"secret://meta",provider_base_url:null,waha_worker_id:null,assignment_fencing_token:null,assignment_lease_expires_at:null,media_days:30}],rowCount:1};
    throw new Error(`Unexpected context query: ${sql}`);
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"event-1",tenantId:"tenant-a",connectionId:"20000000-0000-4000-8000-000000000002",provider:"meta"};
  const expected={providerSessionId:identity.provider_session_id,phoneNumberId:identity.opaque_session_id,wabaId:identity.meta_waba_id,proof,lifecycle};
  const context=await repository.context(event,"group-1");
  assert.equal(context?.zammadGroup,support?"9":"2");
  assert.equal(context?.fixedOwnerId,support?"42":null);
  assert.equal(context?.clientRoute?.status,support?"FALLBACK":undefined);
  assert.deepEqual(context?.metaCredentialContext,expected);
  assert.deepEqual((await repository.workspaceMediaContext(event,"group-1"))?.metaCredentialContext,expected);
  assert.equal(queries.filter(sql=>sql.includes("provider_state_data->>'wabaId'")).length,2);
  assert.equal(queries.filter(sql=>sql.includes("provider_state_data->'metaAccountProof'")).length,2);
  await assert.rejects(()=>repository.currentMetaCredentialProof(event,"secret://meta",context.metaCredentialContext),/lifecycle reconciliation/u);
});

test("inbound Meta media validates the current proof with the resolved bearer before each provider request",async()=>{
  const accessToken="current-token";
  const proof={credentialFingerprint:createHash("sha256").update(accessToken).digest("hex")};
  const context={connectionSecretReference:"secret://tenant-a/connections/meta",providerSessionId:"15550001111",mediaEnabled:true,retentionDays:30,
    metaCredentialContext:{providerSessionId:"90000000-0000-4000-8000-000000000001",phoneNumberId:"15550001111",wabaId:"waba-1",proof}};
  const event={tenantId:"tenant-a",connectionId:"20000000-0000-4000-8000-000000000002",provider:"meta"};
  const verified=[];
  const processor=new InboundProcessor({currentMetaCredentialProof:async(actualEvent,secretReference,actualContext)=>{
    verified.push({actualEvent,secretReference,actualContext});return proof;
  }},{resolve:async()=>assert.fail("The media runtime owns bearer resolution")},{prepare:async input=>{
    assert.equal(typeof input.beforeMetaRequest,"function");
    await input.beforeMetaRequest(accessToken);
    return{attachment:{filename:"proof.png",data:"data","mime-type":"image/png"},mediaObjectId:"media-1",deduplicated:false};
  }},8,undefined,"meta-app-1");
  await processor.prepareMedia(event,context,{media:{type:"image",url:"meta-media://media-1",mimeType:"image/png",fileName:"proof.png"}});
  assert.deepEqual(verified,[{actualEvent:event,secretReference:context.connectionSecretReference,actualContext:context.metaCredentialContext}]);
});

test("inbound Meta media fails closed when the revalidated proof does not match the bearer",async()=>{
  const context={connectionSecretReference:"secret://tenant-a/connections/meta",providerSessionId:"15550001111",mediaEnabled:true,retentionDays:30,
    metaCredentialContext:{providerSessionId:"90000000-0000-4000-8000-000000000001",phoneNumberId:"15550001111",wabaId:null,proof:null}};
  const processor=new InboundProcessor({currentMetaCredentialProof:async()=>({credentialFingerprint:createHash("sha256").update("old-token").digest("hex")})},
    {resolve:async()=>assert.fail("The media runtime owns bearer resolution")},{prepare:async input=>{
      await input.beforeMetaRequest("current-token");
      assert.fail("A stale proof must stop before the provider request");
    }},8,undefined,"meta-app-1");
  await assert.rejects(()=>processor.prepareMedia({tenantId:"tenant-a",connectionId:"20000000-0000-4000-8000-000000000002",provider:"meta"},context,
    {media:{type:"image",url:"meta-media://media-1",mimeType:"image/png"}}),/credentials could not be verified/u);
});


test("inbound Meta media stops before credentials or fetch when its lifecycle snapshot is blocked or malformed",async()=>{
  const {applyMetaLifecycleObservation}=await import("../services/connector-worker/dist/packages/core/src/meta-account-relation.js");
  const blocked=applyMetaLifecycleObservation(undefined,{event:"ACCOUNT_OFFBOARDED",kind:"BLOCK",reasons:["ACCOUNT_OFFBOARDED"],observedAt:"2026-10-07T10:00:00.000Z",payloadSha256:"a".repeat(64)}).state;
  for(const lifecycle of [blocked,null,{schemaVersion:1,revision:1}]){
    const context={connectionSecretReference:"secret://tenant-a/connections/meta",providerSessionId:"15550001111",mediaEnabled:true,retentionDays:30,
      metaCredentialContext:{providerSessionId:"90000000-0000-4000-8000-000000000001",phoneNumberId:"15550001111",wabaId:"123456",proof:null,lifecycle}};
    const processor=new InboundProcessor({currentMetaCredentialProof:async()=>assert.fail("Held lifecycle must stop before proof lookup")},
      {resolve:async()=>assert.fail("No credential resolution")},{prepare:async input=>{await input.beforeMetaRequest("synthetic-token");assert.fail("No provider fetch")}},8,undefined,"123456");
    await assert.rejects(()=>processor.prepareMedia({tenantId:"tenant-a",connectionId:"connection-a",provider:"meta"},context,
      {media:{type:"image",url:"meta-media://media-1",mimeType:"image/png"}}),/lifecycle reconciliation/u);
  }
});
