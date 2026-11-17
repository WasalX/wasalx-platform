import assert from "node:assert/strict";
import test from "node:test";
import { WahaAdapter } from "../services/connector-worker/dist/packages/connectors/src/waha.js";
import { ProviderError } from "../services/connector-worker/dist/packages/connectors/src/types.js";

const sessionResponse = (status, extra = {}) => ({
  name: "tenant/session one",
  status,
  engine: { engine: "GOWS", leaked: "not-returned" },
  config: { proxy: { password: "never-return-this" } },
  ...extra,
});

function adapter() {
  return new WahaAdapter({
    baseUrl: "https://waha.private.example/root",
    apiKey: "test-api-key",
    sessionFor: () => "tenant/session one",
  });
}

test("GOWS discovery advances a full page and stops at an empty final page",async()=>{
  const page=Array.from({length:100},(_,i)=>({JID:`120363000000${String(i).padStart(6,"0")}@g.us`,Name:`Synthetic group ${i}`,Participants:[],ParticipantCount:0}));
  const urls=[];
  await withFetch(async input=>{urls.push(new URL(String(input)));return Response.json(urls.length===1?page:[])},async()=>{
    const client=adapter();const first=await client.listGroups("connection-1");
    assert.equal(first.groups.length,100);assert.equal(first.nextCursor,"100");
    assert.deepEqual(await client.listGroups("connection-1",first.nextCursor),{groups:[],nextCursor:undefined});
  });
  assert.deepEqual(urls.map(url=>url.search),["?limit=100&offset=0","?limit=100&offset=100"]);
});

const reconciliationOptions = {
  start: true,
  expectedEngine: "GOWS",
  config: {
    metadata: { connectionId: "connection-1" },
    webhooks: [{
      url: "https://app.wasalx.example/webhooks/waha/opaque-route-token",
      events: ["message", "message.any", "session.status"],
      hmac: { key: "webhook-signing-key-at-least-16" },
      retries: { policy: "exponential", delaySeconds: 2, attempts: 15 },
    }],
  },
};

const reconciledSession = (extra = {}) => sessionResponse("WORKING", {
  config: reconciliationOptions.config,
  ...extra,
});

async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("WAHA lifecycle methods use granular encoded session endpoints and expose sanitized snapshots", async () => {
  const calls = [];
  const responses = [
    sessionResponse("STARTING"),
    sessionResponse("SCAN_QR_CODE"),
    sessionResponse("STARTING"),
    sessionResponse("STOPPED"),
    undefined,
  ];
  await withFetch(
    async (input, init = {}) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      return response === undefined
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    },
    async () => {
      assert.deepEqual(
        await adapter().createSession("connection-1", { start: false, config: { metadata: { tenant: "tenant-1" } } }),
        { sessionId: "tenant/session one", status: "STARTING", engine: "GOWS" },
      );
      assert.deepEqual(await adapter().startSession("connection-1"), {
        sessionId: "tenant/session one",
        status: "SCAN_QR_CODE",
        engine: "GOWS",
      });
      assert.deepEqual(await adapter().restartSession("connection-1"), {
        sessionId: "tenant/session one",
        status: "STARTING",
        engine: "GOWS",
      });
      assert.deepEqual(await adapter().stopSession("connection-1"), {
        sessionId: "tenant/session one",
        status: "STOPPED",
        engine: "GOWS",
      });
      assert.deepEqual(await adapter().deleteSession("connection-1"), { sessionId: "tenant/session one", deleted: true });
    },
  );

  assert.deepEqual(
    calls.map(({ url, init }) => [new URL(url).pathname, init.method]),
    [
      ["/api/sessions", "POST"],
      ["/api/sessions/tenant%2Fsession%20one/start", "POST"],
      ["/api/sessions/tenant%2Fsession%20one/restart", "POST"],
      ["/api/sessions/tenant%2Fsession%20one/stop", "POST"],
      ["/api/sessions/tenant%2Fsession%20one", "DELETE"],
    ],
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: "tenant/session one",
    start: false,
    config: { metadata: { tenant: "tenant-1" } },
  });
  assert.equal(calls.every(({ init }) => init.headers["x-api-key"] === "test-api-key"), true);
});

test("stopped empty-engine sessions require same-worker engine attestation before reuse",async()=>{
  for(const operation of ["verifySessionContract","reconcileSessionContract"]){
    const paths=[];
    await withFetch(async input=>{
      const path=new URL(String(input)).pathname;paths.push(path);
      return Response.json(path.endsWith("/server/version")?{engine:"GOWS"}:reconciledSession({status:"STOPPED",engine:{}}));
    },async()=>assert.deepEqual(await adapter()[operation]("connection-1",reconciliationOptions),{sessionId:"tenant/session one",status:"STOPPED",engine:"GOWS"}));
    assert.equal(paths.length,2);
    for(const engine of ["NOWEB",undefined]){
      await withFetch(async input=>Response.json(String(input).endsWith("/server/version")?{engine}:reconciledSession({status:"STOPPED",engine:{}})),
        async()=>assert.rejects(()=>adapter()[operation]("connection-1",reconciliationOptions),error=>error.code==="WAHA_SESSION_RECONCILIATION_MISMATCH"));
    }
    await withFetch(async input=>{
      assert.equal(String(input).endsWith("/server/version"),false,"explicit conflicting session engine must not use fallback");
      return Response.json(reconciledSession({status:"STOPPED",engine:{engine:"NOWEB"}}));
    },async()=>assert.rejects(()=>adapter()[operation]("connection-1",reconciliationOptions),error=>error.code==="WAHA_SESSION_RECONCILIATION_MISMATCH"));
  }
});

test("WAHA reconciles a drifted session config once and verifies the final contract",async()=>{
  const calls=[];const drifted=reconciledSession({config:{...reconciliationOptions.config,webhooks:[{...reconciliationOptions.config.webhooks[0],url:"https://old.invalid/webhook"}]}});
  await withFetch(async(input,init={})=>{
    calls.push({path:new URL(String(input)).pathname,method:init.method??"GET",body:init.body&&JSON.parse(String(init.body))});
    if(calls.length===1)return Response.json(drifted);
    if(calls.length===2)return Response.json({});
    return Response.json(reconciledSession());
  },async()=>assert.deepEqual(await adapter().reconcileSessionContract("connection-1",reconciliationOptions),{sessionId:"tenant/session one",status:"WORKING",engine:"GOWS",reconciled:true}));
  assert.deepEqual(calls.map(({path,method})=>[path,method]),[
    ["/api/sessions/tenant%2Fsession%20one","GET"],
    ["/api/sessions/tenant%2Fsession%20one","PUT"],
    ["/api/sessions/tenant%2Fsession%20one","GET"],
  ]);
  assert.deepEqual(calls[1].body,{config:reconciliationOptions.config});
});

test("WAHA reconciles an ambiguous session config PUT only when GET proves the exact contract",async()=>{
  let calls=0;
  await withFetch(async()=>{calls++;if(calls===1)return Response.json(reconciledSession({config:{...reconciliationOptions.config,metadata:{connectionId:"drifted"}}}));if(calls===2)throw new TypeError("response lost");return Response.json(reconciledSession())},async()=>{
    const result=await adapter().reconcileSessionContract("connection-1",reconciliationOptions);
    assert.equal(result.reconciled,true);
  });
  assert.equal(calls,3);
});

test("group discovery normalizes pinned GOWS records and the legacy REST projection", async () => {
  const calls = [];
  const responses = [
    [{ JID: "120363000000000001@g.us", Name: "GOWS operations", Participants: [
      {JID:"12025550130@lid",PhoneNumber:"12025550120@s.whatsapp.net",DisplayName:"Noura"},
      {JID:"12025550160@lid",PhoneNumber:"12025550121@s.whatsapp.net",DisplayName:""},
    ], ParticipantCount: 0 }],
    [{id:"12025550160@lid",name:"",pushname:"MKT"}],
    [{ id: "120363000000000002@g.us", name: "Legacy operations", participants: [{}] }],
  ];
  await withFetch(async (input) => {
    calls.push(String(input));
    return Response.json(responses.shift());
  }, async () => {
    assert.deepEqual(await adapter().listGroups("connection-1"), {
      groups: [{ id: "120363000000000001@g.us", name: "GOWS operations", participants: 2,participantRoster:[
        {id:"12025550130@lid",normalizedPhone:"+12025550120",displayName:"Noura"},
        {id:"12025550160@lid",normalizedPhone:"+12025550121",displayName:"MKT"},
      ] }],
      nextCursor: undefined,
    });
    assert.deepEqual(await adapter().listGroups("connection-1", "100"), {
      groups: [{ id: "120363000000000002@g.us", name: "Legacy operations", participants: 1 }],
      nextCursor: undefined,
    });
  });
  assert.deepEqual(calls.map((url) => `${new URL(url).pathname}${new URL(url).search}`), [
    "/api/tenant%2Fsession%20one/groups?limit=100&offset=0",
    "/api/contacts/all?session=tenant%2Fsession%20one",
    "/api/tenant%2Fsession%20one/groups?limit=100&offset=100",
  ]);

  await withFetch(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/groups")) return Response.json([{ JID: "120363000000000004@g.us", Name: "Fallback operations", Participants: [{ JID: "12025550174@lid", PhoneNumber: "12025550194@s.whatsapp.net", DisplayName: "" }] }]);
    throw new TypeError("contacts unavailable");
  }, async () => {
    assert.deepEqual((await adapter().listGroups("connection-1")).groups[0].participantRoster, [{ id: "12025550174@lid", normalizedPhone: "+12025550194" }]);
  });

  await withFetch(async () => Response.json([{ JID: "120363000000000003@g.us", Participants: [] }]), async () => {
    await assert.rejects(
      () => adapter().listGroups("connection-1"),
      (error) => error instanceof ProviderError && error.code === "WAHA_INVALID_RESPONSE" && !error.retryable,
    );
  });
});

test("ambiguous and exact already-existing session creates reconcile the exact provider contract",async()=>{
  for(const firstResponse of ["network",new Response(JSON.stringify({statusCode:422,message:"Session already exists",error:"Unprocessable Entity"}),{status:422})]){
    const calls=[];
    await withFetch(async(input,init={})=>{calls.push({url:String(input),init});if(calls.length===1){if(firstResponse==="network")throw new TypeError("socket closed");return firstResponse}return Response.json(reconciledSession())},async()=>{
      const result=await adapter().createSession("connection-1",reconciliationOptions);
      assert.deepEqual(result,{sessionId:"tenant/session one",status:"WORKING",engine:"GOWS",reconciled:true});
      assert.equal(JSON.stringify(result).includes("webhook-signing-key"),false);
    });
    assert.deepEqual(calls.map(call=>[new URL(call.url).pathname,call.init.method??"GET"]),[["/api/sessions","POST"],["/api/sessions/tenant%2Fsession%20one","GET"]]);
  }
});

test("session reconciliation fails closed on ownership, engine, or webhook contract mismatch",async()=>{
  const variants=[
    {name:"other/session"},
    {engine:{engine:"NOWEB"}},
    {config:{...reconciliationOptions.config,metadata:{connectionId:"other-connection"}}},
    {config:{...reconciliationOptions.config,webhooks:[{...reconciliationOptions.config.webhooks[0],url:"https://attacker.invalid/webhook"}]}},
    {config:{...reconciliationOptions.config,webhooks:[{...reconciliationOptions.config.webhooks[0],hmac:{key:"different-secret"}}]}},
  ];
  for(const variant of variants){
    await withFetch(async(_input,init={})=>init.method==="POST"?new Response(JSON.stringify({message:"Session already exists"}),{status:422}):Response.json(reconciledSession(variant)),async()=>{
      await assert.rejects(()=>adapter().createSession("connection-1",reconciliationOptions),(error)=>error instanceof ProviderError&&error.code==="WAHA_SESSION_RECONCILIATION_MISMATCH"&&!error.retryable&&!error.message.includes("webhook-signing-key")&&!error.message.includes("different-secret"));
    });
  }
});

test("unrelated 422 responses are not treated as already-existing sessions",async()=>{
  let calls=0;
  await withFetch(async()=>{calls+=1;return new Response(JSON.stringify({message:"Invalid session configuration"}),{status:422})},async()=>{
    await assert.rejects(()=>adapter().createSession("connection-1",reconciliationOptions),(error)=>error instanceof ProviderError&&error.code==="WAHA_HTTP"&&error.status===422&&!error.retryable);
  });
  assert.equal(calls,1);
});

test("QR and pairing-code methods request documented JSON forms and normalize output", async () => {
  const calls = [];
  await withFetch(
    async (input, init = {}) => {
      calls.push({ url: String(input), init });
      const pathname = new URL(String(input)).pathname;
      const body = pathname.endsWith("/qr")
        ? { mimetype: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" , ignored: "value" }
        : { code: "ABCD-1234", internal: "not-returned" };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    async () => {
      assert.deepEqual(await adapter().getQr("connection-1"), { mimeType: "image/png", data: "iVBORw0KGgo=" });
      assert.deepEqual(await adapter().requestPairingCode("connection-1", "12025550131"), { code: "ABCD-1234" });
    },
  );

  assert.equal(new URL(calls[0].url).pathname, "/api/tenant%2Fsession%20one/auth/qr");
  assert.equal(new URL(calls[0].url).search, "?format=image");
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.equal(new URL(calls[1].url).pathname, "/api/tenant%2Fsession%20one/auth/request-code");
  assert.deepEqual(JSON.parse(calls[1].init.body), { phoneNumber: "12025550131" });
});

test("passkey methods preserve only valid WebAuthn fields and use challenge, assertion, and confirmation endpoints", async () => {
  const calls = [];
  const challenge = {
    challenge: "YWJjZA",
    timeout: 60_000,
    rpId: "web.whatsapp.com",
    allowCredentials: [{ id: "Y3JlZGVudGlhbA", type: "public-key", transports: ["internal", "hybrid", "unknown"] }],
    userVerification: "required",
    malicious: "not-returned",
  };
  const responses = [challenge, { status: "accepted", providerSecret: "hidden" }, { code: "1234", ignored: true }, undefined];
  await withFetch(
    async (input, init = {}) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      return response === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(response), { status: 200 });
    },
    async () => {
      assert.deepEqual(await adapter().getPasskeyChallenge("connection-1"), {
        challenge: "YWJjZA",
        timeout: 60_000,
        rpId: "web.whatsapp.com",
        allowCredentials: [{ id: "Y3JlZGVudGlhbA", type: "public-key", transports: ["internal", "hybrid"] }],
        userVerification: "required",
      });
      const assertion = {
        id: "Y3JlZGVudGlhbA",
        rawId: "Y3JlZGVudGlhbA",
        type: "public-key",
        response: {
          clientDataJSON: "Y2xpZW50",
          authenticatorData: "YXV0aA",
          signature: "c2ln",
          userHandle: null,
          extra: "not-forwarded",
        },
        topLevelExtra: "not-forwarded",
      };
      assert.deepEqual(await adapter().submitPasskey("connection-1", assertion), { accepted: true });
      assert.deepEqual(await adapter().getPasskeyConfirmation("connection-1"), { code: "1234" });
      assert.deepEqual(await adapter().confirmPasskey("connection-1"), { confirmed: true });
    },
  );

  assert.deepEqual(
    calls.map(({ url, init }) => [new URL(url).pathname, init.method ?? "GET"]),
    [
      ["/api/tenant%2Fsession%20one/auth/passkey/challenge", "GET"],
      ["/api/tenant%2Fsession%20one/auth/passkey", "POST"],
      ["/api/tenant%2Fsession%20one/auth/passkey/confirmation", "GET"],
      ["/api/tenant%2Fsession%20one/auth/passkey/confirm", "POST"],
    ],
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    id: "Y3JlZGVudGlhbA",
    rawId: "Y3JlZGVudGlhbA",
    type: "public-key",
    response: {
      clientDataJSON: "Y2xpZW50",
      authenticatorData: "YXV0aA",
      signature: "c2ln",
      userHandle: null,
    },
  });
});

test("invalid lifecycle inputs and malformed authentication responses fail closed", async () => {
  await assert.rejects(
    () => adapter().requestPairingCode("connection-1", "0555 123 456"),
    (error) => error instanceof ProviderError && error.code === "WAHA_INVALID_REQUEST" && !error.retryable,
  );

  await withFetch(
    async () => new Response(JSON.stringify({ mimetype: "text/html", data: "PHNjcmlwdD4" }), { status: 200 }),
    async () => {
      await assert.rejects(
        () => adapter().getQr("connection-1"),
        (error) => error instanceof ProviderError && error.code === "WAHA_INVALID_RESPONSE" && !error.retryable,
      );
    },
  );

  await withFetch(
    async () => new Response(JSON.stringify({ challenge: "YWJjZA", rpId: "attacker.example" }), { status: 200 }),
    async () => {
      await assert.rejects(
        () => adapter().getPasskeyChallenge("connection-1"),
        (error) => error instanceof ProviderError && error.code === "WAHA_INVALID_RESPONSE" && !error.retryable,
      );
    },
  );
});

test("current direct WAHA identity shape is normalized and provider requests disable redirects", async () => {
  const calls = [];
  await withFetch(
    async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return Response.json({
        id: "12025550131@s.whatsapp.net",
        pushName: "Operations line",
        platform: "hidden-provider-field",
      });
    },
    async () => {
      assert.deepEqual(await adapter().getIdentity("connection-1"), {
        phone: "12025550131",
        displayName: "Operations line",
        sessionId: "tenant/session one",
      });
    },
  );
  assert.equal(new URL(calls[0].input).pathname, "/api/sessions/tenant%2Fsession%20one/me");
  assert.equal(calls[0].init.redirect, "error");
});

test("pinned GOWS structural engine evidence is normalized without trusting a requested label", async () => {
  await withFetch(
    async () => Response.json({
      name: "tenant/session one",
      status: "WORKING",
      engine: { gows: { found: true, connected: true }, grpc: { client: "ready", stream: "ready" } },
    }),
    async () => assert.deepEqual(await adapter().getState("connection-1"), {
      state: "WORKING",
      detail: "WORKING",
      engine: "GOWS",
    }),
  );
});

test("WAHA adapter bounds response reads before parsing", async () => {
  await withFetch(
    async () => new Response("{}", { headers: { "content-length": "3000001" } }),
    async () => {
      await assert.rejects(
        () => adapter().getState("connection-1"),
        (error) => error instanceof ProviderError && error.code === "WAHA_INVALID_RESPONSE" && !error.retryable,
      );
    },
  );
});
