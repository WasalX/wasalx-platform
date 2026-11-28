import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createWahaSimulation } from "../scripts/contracts/waha-simulation-server.mjs";

test("ingress receipts retain only typed acknowledgement and preserve HTTP status without valid body", { timeout: 10_000 }, async t => {
  const fixtureTimeoutMs = 2_000;
  const webhookTimeoutMs = 1_000;
  async function listen(instance, label) {
    t.after(() => {
      instance.close();
      instance.closeAllConnections();
    });
    const listening = once(instance, "listening", { signal: AbortSignal.timeout(fixtureTimeoutMs) });
    instance.listen(0, "127.0.0.1");
    await listening.catch(error => {
      throw new Error(`Could not start the ${label} fixture`, { cause: error });
    });
    return `http://127.0.0.1:${instance.address().port}`;
  }

  const id = "11111111-2222-4333-8444-555555555555";
  let body;
  let type = "application/json";
  let hang = false;
  const receiver = createServer((req, res) => {
    req.resume();
    res.writeHead(202, { "content-type": type });
    if (hang) res.flushHeaders();
    else res.end(body);
  });
  const url = (await listen(receiver, "webhook receiver")) + "/hook";
  const apiKey = "synthetic-key-long";
  const server = createWahaSimulation({
    apiKey, session: "s", groupId: "123@g.us", phone: "12025550102", version: "2026.7.2",
    initialExists: false, webhookDestinations: [url], webhookTimeoutMs,
  });
  const base = await listen(server, "WAHA simulator");
  const created = await fetch(base + "/api/sessions", {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: JSON.stringify({ name: "s", config: { webhooks: [{ url, events: ["message"], hmac: { key: "synthetic-hmac-long" } }] } }),
    signal: AbortSignal.timeout(fixtureTimeoutMs),
  });
  assert.equal(created.status, 201, "WAHA fixture session creation");
  assert.equal((await created.json()).name, "s");
  server.simulateState("WORKING");

  const input = {
    eventId: "evt_01aaaaaaaaaaaaaaaaaaaaaaaa", messageId: "false_123@g.us_ABC",
    chatId: "123@g.us", participant: "12025550120@c.us", text: "synthetic",
  };
  const httpResponse = { status: 202, outcome: "http-response" };
  for (const duplicate of [false, true]) {
    const receipt = { accepted: true, duplicate, event_id: id };
    body = JSON.stringify({ ...receipt, secret: "must-not-retain" });
    assert.deepEqual((await server.emitInbound(input)).results, [{ ...httpResponse, receipt }]);
  }
  for (const invalid of ["{", "null", JSON.stringify({ accepted: "true", duplicate: false, event_id: id }),
    JSON.stringify({ accepted: true, duplicate: false, event_id: "bad" }), "x".repeat(4097)]) {
    body = invalid;
    assert.deepEqual((await server.emitInbound(input)).results, [httpResponse]);
  }
  type = "text/plain";
  body = JSON.stringify({ accepted: true, duplicate: true, event_id: id });
  assert.deepEqual((await server.emitInbound(input)).results, [httpResponse]);

  type = "application/json";
  hang = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = globalThis.fetch;
  const events = new EventEmitter();
  // Keep the real response stream open when the transport omits abort propagation.
  t.mock.method(globalThis, "fetch", async (destination, options) => {
    const response = await realFetch(destination, { ...options, signal: t.signal });
    const stream = response.body;
    const getReader = stream.getReader.bind(stream);
    t.mock.method(stream, "getReader", () => {
      const reader = getReader();
      events.emit("reading", t.mock.method(reader, "cancel"));
      return reader;
    });
    return response;
  });
  const reading = once(events, "reading", { signal: AbortSignal.timeout(fixtureTimeoutMs) });
  const delivery = server.emitInbound(input);
  const [cancel] = await reading.catch(error => {
    throw new Error("WAHA simulator did not start reading the held receipt body", { cause: error });
  });
  t.mock.timers.tick(webhookTimeoutMs);
  assert.equal(cancel.mock.calls[0]?.arguments[0]?.name, "TimeoutError",
    "The webhook deadline must cancel the held receipt reader");
  assert.deepEqual((await delivery).results, [httpResponse]);
});
