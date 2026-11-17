import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sidecarPath = fileURLToPath(new URL("../tools/dev-secret-sidecar.mjs", import.meta.url));
const readBearer = "development-read-token-with-enough-entropy";
const writeBearer = "development-write-token-with-enough-entropy";
const encryptionKey = Buffer.from("test-encryption-key-exactly-32b!", "utf8").toString("base64");
const differentEncryptionKey = Buffer.from("other-encryption-key-exactly-31!", "utf8").toString("base64");
const processTimeoutMs = 15_000;
let directory;
let storePath;
let sidecar;
let baseUrl;

test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), "wasalx-secret-sidecar-"));
  storePath = join(directory, "secrets.enc");
  sidecar = await startSidecar({
    storePath,
    seed: { "secret://seed/connection": { apiKey: "seed-value" } },
  });
  baseUrl = sidecar.baseUrl;
});

test.after(async () => {
  await stopSidecar(sidecar);
  await rm(directory, { recursive: true, force: true });
});

test("preserves authenticated secret resolution", async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const response = await request("/v1/resolve", { reference: "secret://seed/connection" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { apiKey: "seed-value" });
});

test("stores a small JSON object without echoing its values", async () => {
  const value = { routeToken: "opaque-route-token", hmacKey: "private-hmac-key", nested: { enabled: true } };
  const stored = await request("/v1/store", { reference: "secret://tenant/connection/one", value });
  assert.equal(stored.status, 204);
  assert.equal(stored.headers.get("cache-control"), "no-store");
  assert.equal(await stored.text(), "");

  const resolved = await request("/v1/resolve", { reference: "secret://tenant/connection/one" });
  assert.deepEqual(await resolved.json(), value);
});

test("serializes concurrent mutations without losing durable entries", async () => {
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      request("/v1/store", {
        reference: `secret://tenant/concurrent/${index}`,
        value: { token: `concurrent-value-${index}` },
      }),
    ),
  );
  assert.ok(responses.every(response => response.status === 204));
  for (let index = 0; index < responses.length; index += 1) {
    const resolved = await request("/v1/resolve", { reference: `secret://tenant/concurrent/${index}` });
    assert.equal((await resolved.json()).token, `concurrent-value-${index}`);
  }
});

test("encrypts secrets and references on disk with restrictive POSIX permissions", async () => {
  const contents = await readFile(storePath, "utf8");
  assert.doesNotMatch(contents, /seed-value|opaque-route-token|private-hmac-key|secret:\/\//u);
  const envelope = JSON.parse(contents);
  assert.deepEqual(Object.keys(envelope).sort(), ["cipher", "ciphertext", "iv", "tag", "version"]);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.cipher, "aes-256-gcm");
  if (process.platform !== "win32") {
    assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  }
});

test("restores committed values after restart and does not reapply bootstrap seed", async () => {
  await stopSidecar(sidecar);
  sidecar = await startSidecar({
    storePath,
    seed: { "secret://seed/ignored-after-first-start": { token: "must-not-appear" } },
  });
  baseUrl = sidecar.baseUrl;

  const seeded = await request("/v1/resolve", { reference: "secret://seed/connection" });
  assert.deepEqual(await seeded.json(), { apiKey: "seed-value" });
  const stored = await request("/v1/resolve", { reference: "secret://tenant/connection/one" });
  assert.deepEqual(await stored.json(), {
    routeToken: "opaque-route-token",
    hmacKey: "private-hmac-key",
    nested: { enabled: true },
  });
  const ignoredSeed = await request("/v1/resolve", { reference: "secret://seed/ignored-after-first-start" });
  assert.equal(ignoredSeed.status, 404);
});

test("requires valid bearer authentication before accepting writes", async () => {
  const unauthorized = await fetch(`${baseUrl}/v1/store`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
    body: JSON.stringify({ reference: "secret://tenant/rejected", value: { token: "must-not-store" } }),
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

  const missing = await request("/v1/resolve", { reference: "secret://tenant/rejected" });
  assert.equal(missing.status, 404);
});

test("keeps resolve and mutation credentials strictly scoped", async () => {
  const readCannotWrite = await fetch(`${baseUrl}/v1/store`, {
    method: "POST",
    headers: authHeaders(readBearer),
    body: JSON.stringify({ reference: "secret://tenant/rejected-read-token", value: { token: "x" } }),
  });
  assert.equal(readCannotWrite.status, 401);

  const writeCannotRead = await fetch(`${baseUrl}/v1/resolve`, {
    method: "POST",
    headers: authHeaders(writeBearer),
    body: JSON.stringify({ reference: "secret://seed/connection" }),
  });
  assert.equal(writeCannotRead.status, 401);
});

test("rejects invalid JSON, references, and non-object secrets", async () => {
  const invalidJson = await fetch(`${baseUrl}/v1/store`, {
    method: "POST",
    headers: authHeaders(writeBearer),
    body: "{invalid-json",
  });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: "invalid_json" });

  for (const body of [
    { reference: "https://example.test/secret", value: { token: "x" } },
    { reference: "secret://", value: { token: "x" } },
    { reference: "secret://tenant/value", value: "not-an-object" },
    { reference: "secret://tenant/value", value: ["not-an-object"] },
  ]) {
    const response = await request("/v1/store", body);
    assert.equal(response.status, 400);
  }
});

test("rejects prototype-pollution keys at every depth", async () => {
  for (const unsafeValue of [
    '{"reference":"secret://tenant/unsafe-one","value":{"__proto__":{"admin":true}}}',
    '{"reference":"secret://tenant/unsafe-two","value":{"nested":{"constructor":{"prototype":{"admin":true}}}}}',
    '{"reference":"secret://tenant/unsafe-three","value":{"prototype":{"admin":true}}}',
  ]) {
    const response = await fetch(`${baseUrl}/v1/store`, {
      method: "POST",
      headers: authHeaders(writeBearer),
      body: unsafeValue,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_secret" });
  }
  assert.equal(Object.prototype.admin, undefined);
});

test("rejects oversized requests and does not disclose their values", async () => {
  const oversizedSecret = "sensitive-".repeat(2_000);
  const response = await fetch(`${baseUrl}/v1/store`, {
    method: "POST",
    headers: authHeaders(writeBearer),
    body: JSON.stringify({ reference: "secret://tenant/oversized", value: { token: oversizedSecret } }),
  });
  assert.equal(response.status, 413);
  const responseText = await response.text();
  assert.equal(responseText.includes(oversizedSecret), false);
  assert.deepEqual(JSON.parse(responseText), { error: "payload_too_large" });
});

test("deletes secrets idempotently and persists deletion across restart", async () => {
  const first = await request("/v1/delete", { reference: "secret://tenant/connection/one" });
  assert.equal(first.status, 204);
  assert.equal(await first.text(), "");

  const second = await request("/v1/delete", { reference: "secret://tenant/connection/one" });
  assert.equal(second.status, 204);
  assert.equal(await second.text(), "");

  await stopSidecar(sidecar);
  sidecar = await startSidecar({ storePath });
  baseUrl = sidecar.baseUrl;
  const resolved = await request("/v1/resolve", { reference: "secret://tenant/connection/one" });
  assert.equal(resolved.status, 404);
});

test("fails closed on a wrong encryption key without logging stored values", async () => {
  const failure = await expectStartupFailure({ storePath, key: differentEncryptionKey });
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /failed to initialize its encrypted store/u);
  assert.doesNotMatch(failure.stderr, /seed-value|concurrent-value|secret:\/\//u);
});

test("fails closed on a malformed store without logging corrupt contents", async () => {
  const corruptDirectory = await mkdtemp(join(tmpdir(), "wasalx-secret-corrupt-"));
  const corruptPath = join(corruptDirectory, "secrets.enc");
  const corruptValue = "malformed-private-value-that-must-not-be-logged";
  await writeFile(corruptPath, `{"${corruptValue}":`, { mode: 0o600 });
  try {
    const failure = await expectStartupFailure({ storePath: corruptPath });
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /failed to initialize its encrypted store/u);
    assert.equal(failure.stderr.includes(corruptValue), false);
  } finally {
    await rm(corruptDirectory, { recursive: true, force: true });
  }
});

test("requires a distinct valid store-encryption key", async () => {
  const failure = await expectStartupFailure({ storePath, key: "not-a-key" });
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /failed to initialize its encrypted store/u);
  assert.doesNotMatch(failure.stderr, /not-a-key/u);
});

test("refuses to reuse a bearer credential as the encryption key", async () => {
  const failure = await expectStartupFailure({
    storePath,
    key: encryptionKey,
    readToken: encryptionKey,
  });
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /failed to initialize its encrypted store/u);
  assert.equal(failure.stderr.includes(encryptionKey), false);
});

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function request(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(path === "/v1/resolve" ? readBearer : writeBearer),
    body: JSON.stringify(body),
  });
}

async function startSidecar({ storePath: path, key = encryptionKey, seed = {}, faultEnvironment = {} }) {
  const processHandle = spawn(process.execPath, [sidecarPath], {
    env: { ...sidecarEnvironment({ storePath: path, key, seed }), ...faultEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", chunk => { stderr += chunk; });
  processHandle.stdout.setEncoding("utf8");
  const port = await waitForListening(processHandle, () => stderr);
  return { processHandle, baseUrl: `http://127.0.0.1:${port}`, readStderr: () => stderr };
}

async function stopSidecar(handle) {
  if (!handle?.processHandle || handle.processHandle.exitCode !== null) return;
  handle.processHandle.kill("SIGTERM");
  await once(handle.processHandle, "exit");
}

async function expectStartupFailure({
  storePath: path,
  key = encryptionKey,
  readToken = readBearer,
  writeToken = writeBearer,
  faultEnvironment = {},
}) {
  const processHandle = spawn(process.execPath, [sidecarPath], {
    env: { ...sidecarEnvironment({ storePath: path, key, seed: {}, readToken, writeToken }), ...faultEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  processHandle.stdout.setEncoding("utf8");
  processHandle.stderr.setEncoding("utf8");
  processHandle.stdout.on("data", chunk => { stdout += chunk; });
  processHandle.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      processHandle.kill("SIGKILL");
      reject(new Error("sidecar did not fail closed"));
    }, processTimeoutMs);
    processHandle.once("exit", exitCode => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

function sidecarEnvironment({
  storePath: path,
  key,
  seed,
  readToken = readBearer,
  writeToken = writeBearer,
}) {
  return {
    ...process.env,
    DEV_SECRET_STORE_RESPONSE_LOSS_ENABLED: "false",
    DEV_SECRET_STORE_RESPONSE_LOSS_MODE: "",
    DEV_SECRET_STORE_RESPONSE_LOSS_DIR: "",
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    DEV_SECRET_SIDECAR_READ_TOKEN: readToken,
    DEV_SECRET_SIDECAR_WRITE_TOKEN: writeToken,
    DEV_SECRET_STORE_PATH: path,
    DEV_SECRET_STORE_ENCRYPTION_KEY: key,
    DEV_SECRET_STORE_JSON: JSON.stringify(seed),
  };
}

function waitForListening(processHandle, readStderr) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      processHandle.kill("SIGKILL");
      finish(reject, new Error("sidecar startup timed out"));
    }, processTimeoutMs);
    const onData = chunk => {
      const match = chunk.match(/listening on (\d+)/u);
      if (match) finish(resolve, match[1]);
    };
    const onExit = code => finish(reject, new Error(`sidecar exited with ${code}: ${readStderr()}`));
    const finish = (settle, result) => {
      clearTimeout(timeout);
      processHandle.stdout.off("data", onData);
      processHandle.off("exit", onExit);
      settle(result);
    };
    processHandle.stdout.on("data", onData);
    processHandle.once("exit", onExit);
  });
}


test("simulated exact-reference store loss follows real persistence and remains one-shot after restart",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"wasalx-store-loss-"));await chmod(root,0o700);
  let local;
  t.after(async()=>{await stopSidecar(local);await rm(root,{recursive:true,force:true})});
  const tenantId=randomUUID(),connectionId=randomUUID(),claimId=randomUUID(),suffix="a".repeat(64);
  const reference=`secret://${tenantId}/connections/${connectionId}/meta/rotations/${suffix}`;
  const digest=value=>createHash("sha256").update(value).digest("hex"),referenceSha256=digest(reference);
  const claim={schemaVersion:1,tenantId,connectionId,claimId,referenceSha256,
    candidateSha256:"b".repeat(64),runtimeSha256:"c".repeat(64),ownerClaimSha256:"d".repeat(64),
    expiresAt:new Date(Date.now()+120000).toISOString()};
  const claimPath=join(root,"claim.json"),receiptPath=join(root,referenceSha256+".receipt.json");
  await writeFile(claimPath,JSON.stringify(claim),{mode:0o600});
  const faultEnvironment={DEV_SECRET_STORE_RESPONSE_LOSS_ENABLED:"true",DEV_SECRET_STORE_RESPONSE_LOSS_MODE:"SIMULATED",DEV_SECRET_STORE_RESPONSE_LOSS_DIR:root};
  const path=join(root,"secrets.enc"),value={accessToken:"synthetic-post-persist-private-token"};
  local=await startSidecar({storePath:path,faultEnvironment});
  const send=(route,body,token=route==="/v1/resolve"?readBearer:writeBearer)=>fetch(local.baseUrl+route,{method:"POST",headers:authHeaders(token),body:JSON.stringify(body),signal:AbortSignal.timeout(processTimeoutMs)});
  assert.equal((await send("/v1/store",{reference,value},readBearer)).status,401);
  await assert.rejects(()=>readFile(receiptPath),{code:"ENOENT"});
  const foreign=`secret://${tenantId}/connections/${randomUUID()}/meta/rotations/${suffix}`;
  assert.equal((await send("/v1/store",{reference:foreign,value:{accessToken:"synthetic-other-private-token"}})).status,204);
  await assert.rejects(()=>readFile(receiptPath),{code:"ENOENT"});
  assert.equal((await send("/v1/store",{reference,value:"invalid"})).status,400);
  await assert.rejects(()=>readFile(receiptPath),{code:"ENOENT"});
  await assert.rejects(()=>send("/v1/store",{reference,value}),error=>{
    assert.ok(error instanceof TypeError,`Expected socket loss; rejection class: ${error?.name ?? typeof error}`);
    return true;
  },"The original POST loses its HTTP response");
  const receipt=JSON.parse(await readFile(receiptPath,"utf8"));
  assert.equal(receipt.state,"PERSISTED_RESPONSE_DROPPED");assert.equal(receipt.storeAttempts,1);assert.equal(receipt.claimId,claimId);
  assert.deepEqual(await (await send("/v1/resolve",{reference})).json(),value,"Unknown write is recovered only by actual readback");
  assert.doesNotMatch(await readFile(path,"utf8"),/synthetic-post-persist-private-token|secret:\/\//u);
  assert.equal((await send("/v1/store",{reference,value:{accessToken:"must-not-replace-original-token"}})).status,409);
  assert.deepEqual(await (await send("/v1/resolve",{reference})).json(),value);
  await stopSidecar(local);local=await startSidecar({storePath:path,faultEnvironment});
  assert.equal((await send("/v1/store",{reference,value})).status,409);
  assert.deepEqual(JSON.parse(await readFile(receiptPath,"utf8")),receipt,"Restart cannot rearm the original claim");
  assert.deepEqual(await (await send("/v1/resolve",{reference})).json(),value);
  // Removing/replacing the arm cannot erase the original durable fence.
  await rm(claimPath);
  assert.equal((await send("/v1/store",{reference,value:{accessToken:"must-not-overwrite-without-arm"}})).status,409);
  const otherReference=`secret://${tenantId}/connections/${connectionId}/meta/rotations/${"e".repeat(64)}`;
  await writeFile(claimPath,JSON.stringify({...claim,claimId:randomUUID(),referenceSha256:digest(otherReference)}),{mode:0o600});
  assert.equal((await send("/v1/store",{reference,value:{accessToken:"must-not-overwrite-under-other-arm"}})).status,409);
  await stopSidecar(local);local=await startSidecar({storePath:path,faultEnvironment});
  assert.equal((await send("/v1/store",{reference,value:{accessToken:"must-not-overwrite-after-restart"}})).status,409);
  assert.deepEqual(await (await send("/v1/resolve",{reference})).json(),value);
  assert.deepEqual(JSON.parse(await readFile(receiptPath,"utf8")),receipt);
  await rm(claimPath);
  const unclaimed=`secret://${tenantId}/connections/${connectionId}/meta/rotations/${"f".repeat(64)}`;
  assert.equal((await send("/v1/store",{reference:unclaimed,value:{accessToken:"unclaimed-normal-store-value"}})).status,204);
  // A crash-before-persistence receipt also refuses mutation without an arm.
  const uncertain=`secret://${tenantId}/connections/${connectionId}/meta/rotations/${"9".repeat(64)}`;
  const uncertainReceiptPath=join(root,digest(uncertain)+".receipt.json");
  const uncertainReceipt={...claim,claimId:randomUUID(),referenceSha256:digest(uncertain),state:"CLAIMED",storeAttempts:1,claimedAt:new Date().toISOString()};
  await writeFile(uncertainReceiptPath,JSON.stringify(uncertainReceipt),{mode:0o600});
  assert.equal((await send("/v1/store",{reference:uncertain,value})).status,409);
  assert.equal((await send("/v1/resolve",{reference:uncertain})).status,404,"Absence does not permit retry of the unknown claim");
  await stopSidecar(local);local=await startSidecar({storePath:path,faultEnvironment});
  assert.equal((await send("/v1/store",{reference:uncertain,value})).status,409);
  assert.deepEqual(JSON.parse(await readFile(uncertainReceiptPath,"utf8")),uncertainReceipt);
  assert.doesNotMatch(local.readStderr(),/synthetic-post-persist|secret:\/\//u);
});

test("response-loss control stays disabled by default and rejects expired claims before persistence",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"wasalx-store-loss-disabled-"));await chmod(root,0o700);let local;
  t.after(async()=>{await stopSidecar(local);await rm(root,{recursive:true,force:true})});
  const tenantId=randomUUID(),connectionId=randomUUID(),reference=`secret://${tenantId}/connections/${connectionId}/meta/rotations/${"a".repeat(64)}`;
  const claim={schemaVersion:1,tenantId,connectionId,claimId:randomUUID(),referenceSha256:createHash("sha256").update(reference).digest("hex"),candidateSha256:"b".repeat(64),runtimeSha256:"c".repeat(64),ownerClaimSha256:"d".repeat(64),expiresAt:new Date(Date.now()-1000).toISOString()};
  await writeFile(join(root,"claim.json"),JSON.stringify(claim),{mode:0o600});
  local=await startSidecar({storePath:join(root,"disabled.enc"),faultEnvironment:{DEV_SECRET_STORE_RESPONSE_LOSS_DIR:root}});
  const send=()=>fetch(local.baseUrl+"/v1/store",{method:"POST",headers:authHeaders(writeBearer),body:JSON.stringify({reference,value:{accessToken:"synthetic-default-normal-store"}})});
  assert.equal((await send()).status,204);await stopSidecar(local);
  local=await startSidecar({storePath:join(root,"expired.enc"),faultEnvironment:{DEV_SECRET_STORE_RESPONSE_LOSS_ENABLED:"true",DEV_SECRET_STORE_RESPONSE_LOSS_MODE:"SIMULATED",DEV_SECRET_STORE_RESPONSE_LOSS_DIR:root}});
  assert.equal((await send()).status,503);
  assert.equal((await fetch(local.baseUrl+"/v1/resolve",{method:"POST",headers:authHeaders(readBearer),body:JSON.stringify({reference})})).status,404);
  await assert.rejects(()=>readFile(join(root,claim.referenceSha256+".receipt.json")),{code:"ENOENT"});
});


test("response-loss enablement refuses production and unmarked execution",async()=>{
  const fault={DEV_SECRET_STORE_RESPONSE_LOSS_ENABLED:"true",DEV_SECRET_STORE_RESPONSE_LOSS_DIR:directory};
  for(const extra of [{DEV_SECRET_STORE_RESPONSE_LOSS_MODE:"LIVE"},{DEV_SECRET_STORE_RESPONSE_LOSS_MODE:"SIMULATED",NODE_ENV:"production"}]){
    const result=await expectStartupFailure({storePath,faultEnvironment:{...fault,...extra}});
    assert.equal(result.code,1);assert.doesNotMatch(result.stderr,/secret:\/\/|seed-value|concurrent-value/u);
  }
});
