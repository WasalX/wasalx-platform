import assert from "node:assert/strict";
import test from "node:test";

const policy = { id: "99000000-0000-4000-8000-000000000001", zammadGroupId: "2", zammadOwnerId: "19", enabled: true };
const fresh = () => import(`../lib/fixture-data.ts?native-routing=${crypto.randomUUID()}`);

test("routing fixture save stays pending until explicit simulated readback", async () => {
  const fixture = await fresh();
  assert.equal((await fixture.getNativeRoutingSync()).state, "UNCONFIGURED");
  const saved = await fixture.updateNativeRoutingSync({ action: "SAVE_DEFAULTS", expectedRevision: 0, departmentDefaults: [policy] }, "save");
  assert.equal(saved.state, "PENDING");
  assert.equal(saved.desiredRevision, 1);
  assert.equal(saved.appliedRevision, 0);
  assert.equal(saved.observedSha256, null);
  const checked = await fixture.updateNativeRoutingSync({ action: "CHECK", expectedRevision: 1 }, "check");
  assert.equal(checked.state, "SYNCED");
  assert.equal(checked.appliedRevision, 1);
  assert.match(checked.observedSha256, /^[a-f0-9]{64}$/u);
  assert.equal(checked.observedSha256, checked.desiredSha256);
  checked.departmentDefaults[0].zammadOwnerId = "21";
  assert.equal((await fixture.getNativeRoutingSync()).departmentDefaults[0].zammadOwnerId, "19");
});

test("routing fixture preserves exact idempotency and revision conflict behavior", async () => {
  const fixture = await fresh();
  const command = { action: "SAVE_DEFAULTS", expectedRevision: 0, departmentDefaults: [policy] };
  const saved = await fixture.updateNativeRoutingSync(command, "same-key");
  saved.departmentDefaults.length = 0;
  assert.equal((await fixture.updateNativeRoutingSync(command, "same-key")).departmentDefaults.length, 1);
  await assert.rejects(() => fixture.updateNativeRoutingSync({ ...command, departmentDefaults: [] }, "same-key"), error => error.code === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(() => fixture.updateNativeRoutingSync({ action: "CHECK", expectedRevision: 0 }, "stale"), error => error.code === "NATIVE_ROUTING_REVISION_CONFLICT");
  assert.equal((await fixture.getNativeRoutingSync()).desiredRevision, 1);
});

test("routing fixture validates enabled targets but permits retiring an unavailable target", async () => {
  const fixture = await fresh();
  await assert.rejects(() => fixture.updateNativeRoutingSync({ action: "SAVE_DEFAULTS", expectedRevision: 0, departmentDefaults: [{ ...policy, zammadGroupId: "99" }] }, "invalid"), error => error.code === "NATIVE_ROUTING_TARGET_INVALID");
  assert.equal((await fixture.getNativeRoutingSync()).desiredRevision, 0);
  const result = await fixture.updateNativeRoutingSync({ action: "SAVE_DEFAULTS", expectedRevision: 0, departmentDefaults: [{ ...policy, zammadGroupId: "99", zammadOwnerId: "98", enabled: false }] }, "retire");
  assert.equal(result.state, "PENDING");
  assert.equal(result.departmentDefaults[0].enabled, false);
});

test("routing fixture rejects duplicate queues and unsupported force without mutation", async () => {
  const fixture = await fresh();
  await assert.rejects(() => fixture.updateNativeRoutingSync({ action: "SAVE_DEFAULTS", expectedRevision: 0, departmentDefaults: [policy, { ...policy, id: "99000000-0000-4000-8000-000000000002" }] }, "duplicate"), /NATIVE_ROUTING_VALIDATION_ERROR/u);
  await assert.rejects(() => fixture.updateNativeRoutingSync({ action: "CHECK", expectedRevision: 0, force: true }, "force"), /NATIVE_ROUTING_VALIDATION_ERROR/u);
  assert.equal((await fixture.getNativeRoutingSync()).state, "UNCONFIGURED");
});

test("routing fixture active changes invalidate the prior readback without changing its provenance", async () => {
  const fixture = await fresh();
  await fixture.updateNativeRoutingSync({ action: "SAVE_DEFAULTS", expectedRevision: 0, departmentDefaults: [] }, "save");
  const checked = await fixture.updateNativeRoutingSync({ action: "CHECK", expectedRevision: 1 }, "check");
  await fixture.toggleGroup("grp_riyadh", false, "Fixture test");
  const changed = await fixture.getNativeRoutingSync();
  assert.equal(changed.state, "PENDING");
  assert.equal(changed.desiredRevision, 2);
  assert.equal(changed.appliedRevision, 1);
  assert.equal(changed.observedSha256, checked.observedSha256);
  assert.equal(changed.desiredSha256, null);
});

test("routing fixture draft creation has no sync effect, activation publishes new intent", async () => {
  const fixture = await fresh();
  const active = (await fixture.getClientRouting())[0];
  const draft = await fixture.createClientRouting(active.definition);
  assert.equal((await fixture.getNativeRoutingSync()).state, "UNCONFIGURED");
  await fixture.activateClientRouting(draft.id, { expectedRevision: draft.revision });
  assert.equal((await fixture.getNativeRoutingSync()).state, "PENDING");
});

test("sample client routing names follow the viewer's language", async () => {
  const { getMessages } = await import("../lib/i18n/messages/index.ts");
  const fixture = await fresh();
  for (const locale of ["en", "ar"]) {
    const messages = getMessages(locale);
    const sample = (await fixture.getClientRouting(locale)).find((row) => row.id === "86000000-0000-4000-8000-000000000001");
    assert.equal(sample.definition.name, messages["routing.starter.name"]);
    assert.deepEqual(sample.definition.sources.map((source) => source.name), [messages["routing.starter.source"], messages["routing.sample.notionSource"]]);
  }
  assert.match(getMessages("ar")["routing.sample.notionSource"], /Notion/u);
});
