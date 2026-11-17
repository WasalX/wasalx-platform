import assert from "node:assert/strict";
import test from "node:test";
import { metaCoexistenceUnits, coexistencePhone, coexistenceSubjectDigest } from "../packages/core/dist/meta-coexistence.js";

const business = "12025550138", customer = "12025550163", account = "77777777", phone = "88888888";
const now = Date.now(), timestamp = String(Math.floor(now / 1000) - 60);
const metadata = { display_phone_number: business, phone_number_id: phone };
const message = { id: "wamid.synthetic", from: customer, timestamp, type: "text", text: { body: "inert history" } };
const history = () => ({ messaging_product: "whatsapp", metadata, history: [{ metadata: { phase: 2, chunk_order: 8, progress: 100 }, threads: [{ id: customer, messages: [message] }] }] });
const parse = (value, field = "history") => metaCoexistenceUnits(account, field, value, now);

test("history normalizes one chunk with truthful provider progress, direction and no live envelope", () => {
  const [unit] = parse(history());
  assert.equal(unit.kind, "HISTORY"); assert.equal(unit.key, "2:8"); assert.equal(unit.progress, 100);
  assert.equal(unit.messages[0].direction, "INBOUND"); assert.equal(unit.messages[0].subject, customer);
  assert.equal(unit.messages[0].text, "inert history"); assert.equal(unit.entry, undefined);
  const outgoing = history(); outgoing.history[0].threads[0].messages = [{ ...message, from: business }];
  assert.equal(parse(outgoing)[0].messages[0].direction, "OUTBOUND");
});
for (const [name, mutate] of [
  ["group", v => { v.history[0].threads[0].id = "12345@g.us"; }],
  ["explicit group", v => { v.history[0].threads[0].messages[0] = { ...message, group_id: "12345" }; }],
  ["group thread marker", v => { v.history[0].threads[0].group_id = "12345"; }],
  ["group metadata marker", v => { v.metadata = { ...metadata, group_id: "12345" }; }],
  ["foreign sender", v => { v.history[0].threads[0].messages[0] = { ...message, from: "15550000003" }; }],
  ["future", v => { v.history[0].threads[0].messages[0] = { ...message, timestamp: String(Math.floor(now/1000)+301) }; }],
  ["phase", v => { v.history[0].metadata.phase = 3; }],
  ["negative chunk", v => { v.history[0].metadata.chunk_order = -1; }],
  ["fraction progress", v => { v.history[0].metadata.progress = 0.5; }],
  ["mixed live", v => { v.messages = [message]; }],
  ["mixed decline", v => { v.history[0].errors = [{ code: 2593109 }]; }],
]) test(`malformed history is rejected atomically: ${name}`, () => { const value = history(); mutate(value); assert.throws(() => parse(value)); });

test("decline is a distinct observation, not empty history success", () => {
  assert.equal(parse({ messaging_product: "whatsapp", metadata, history: [{ errors: [{ code: 2593109, message: "untrusted details" }] }] })[0].kind, "DECLINED");
  assert.throws(() => parse({ messaging_product: "whatsapp", metadata, history: [{ errors: [{ code: 1 }] }] }));
});
test("media supplement retains inert customer association and no standalone live envelope", () => {
  const [unit] = parse({ messaging_product: "whatsapp", metadata, messages: [{ ...message, type: "image", image: { id: "12345678", caption: "image" } }] });
  assert.equal(unit.kind, "HISTORY_MEDIA"); assert.equal(unit.messages[0].mediaId, "12345678");
  assert.throws(() => parse({ messaging_product: "whatsapp", metadata, messages: [message] }));
});
test("app echo requires exact business sender/customer recipient and stays outbound", () => {
  const value = { messaging_product: "whatsapp", metadata, message_echoes: [{ ...message, from: business, to: customer }] };
  assert.equal(parse(value, "smb_message_echoes")[0].messages[0].direction, "OUTBOUND");
  assert.throws(() => parse({ ...value, message_echoes: [message] }, "smb_message_echoes"));
  assert.throws(() => parse(value, "history"));
  assert.throws(() => parse({ ...value, message_echoes: [{ ...value.message_echoes[0], group_id: "12345" }] }, "smb_message_echoes"));
  assert.throws(() => parse({ messaging_product: "whatsapp", metadata, messages: [{ ...message, group_id: "12345", type: "image", image: { id: "12345678" } }] }));
});
test("source digest covers the selected raw unit, survives rebatching/key order and detects changed content", () => {
  const value = history(), [first] = parse(value);
  const companion = structuredClone(value.history[0]); companion.metadata.chunk_order++;
  value.history.push(companion);
  assert.equal(parse(value)[0].sourceSha256, first.sourceSha256);
  value.metadata = { phone_number_id: phone, display_phone_number: business };
  assert.equal(parse(value)[0].sourceSha256, first.sourceSha256);
  value.history[0].threads[0].messages[0] = { ...message, text: { body: "changed" } };
  assert.notEqual(parse(value)[0].sourceSha256, first.sourceSha256);
});
test("contact removal accepts absent names and retains source order", () => {
  const value = { messaging_product: "whatsapp", metadata, state_sync: [{ type: "contact", action: "remove", contact: { phone_number: customer }, metadata: { timestamp } }] };
  const [unit] = parse(value, "smb_app_state_sync");
  assert.deepEqual(unit.contacts, [{ subject: customer, name: null, action: "remove", timestamp: Number(timestamp) }]);
  assert.throws(() => parse({ ...value, state_sync: [{ ...value.state_sync[0], action: "unknown" }] }, "smb_app_state_sync"));
});
test("privacy digest is stable across context/session/reconsent and isolated by tenant/app/business phone", () => {
  const digest = coexistenceSubjectDigest("tenant-a", "123456", phone, customer);
  assert.equal(digest, coexistenceSubjectDigest("tenant-a", "123456", phone, customer));
  for (const args of [["tenant-b", "123456", phone, customer], ["tenant-a", "654321", phone, customer], ["tenant-a", "123456", "999999", customer]]) assert.notEqual(digest, coexistenceSubjectDigest(...args));
  assert.equal(coexistencePhone("12025550163"), customer);
  assert.equal(coexistencePhone("12345@g.us"), undefined);
});
