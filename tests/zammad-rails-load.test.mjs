import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { railsLoadModel, assertRailsLoadOutput, successMarker, withRailsLoadCleanup } from "../scripts/check-zammad-rails-load.mjs";

const image = "wasalx/rails-load:00000000-0000-4000-8000-000000000001";
const base = `ghcr.io/zammad/zammad@sha256:${"a".repeat(64)}`;

test("cold Rails boot uses the current package and a fresh base schema without workers or compatibility", () => {
  const model = railsLoadModel(image, base);
  assert.deepEqual(Object.keys(model.services).sort(), ["zammad-init", "zammad-load", "zammad-memcached", "zammad-postgresql", "zammad-redis"]);
  assert.equal(model.services["zammad-init"].image, base);
  assert.deepEqual(model.services["zammad-init"].command, ["zammad-init"]);
  const load = model.services["zammad-load"];
  assert.equal(load.image, image);
  assert.deepEqual(load.command, ["bundle", "exec", "rails", "runner", `Rails.application.eager_load!; puts '${successMarker}'`]);
  assert.equal(load.environment.RAILS_ENV, "production");
  assert.equal(Object.hasOwn(load.environment, "ZAMMAD_SAFE_MODE"), false);
});

test("cold Rails fixture has no published ports, external network, host data or provider credentials", () => {
  const model = railsLoadModel(image, base);
  assert.deepEqual(model.networks, { default: { internal: true } });
  assert.deepEqual(Object.keys(model.volumes).sort(), ["zammad-backup", "zammad-storage"]);
  for (const service of Object.values(model.services)) {
    assert.equal(Object.hasOwn(service, "ports"), false);
    assert.equal(service.mem_limit, service.memswap_limit);
    assert.ok(service.cpus > 0 && service.cpus <= 2);
    for (const value of service.volumes ?? []) assert.match(value, /^zammad-(?:storage|backup):/u);
    assert.ok(!Object.keys(service.environment ?? {}).some(key => /META|WAHA|ACCESS_TOKEN|SERVICE_TOKEN|GITHUB|OIDC/iu.test(key)));
  }
  assert.deepEqual(model.services["zammad-postgresql"].tmpfs, ["/var/lib/postgresql/data"]);
  assert.equal(model.services["zammad-load"].environment.WASALX_CONTROL_URL, "http://127.0.0.1:9");
});

test("cold Rails fixture refuses foreign or mutable image references", () => {
  for (const invalid of ["zammad:latest", "wasalx/rails-load:latest", image + ";other"]) {
    assert.throws(() => railsLoadModel(invalid, base));
  }
  for (const invalid of ["ghcr.io/zammad/zammad:latest", "foreign.example/zammad@sha256:" + "a".repeat(64)]) {
    assert.throws(() => railsLoadModel(image, invalid));
  }
});

test("Rails success requires the complete marker emitted after eager loading", () => {
  assertRailsLoadOutput(`booted\n${successMarker}\r\n`);
  for (const output of ["", "booted", successMarker + " extra", "prefix " + successMarker]) {
    assert.throws(() => assertRailsLoadOutput(output));
  }
});

test("build and Rails-load failures each settle once and retain their original failure", async () => {
  for (const phase of ["build", "load"]) {
    const primary = new Error(`${phase} failed`), signals = new EventEmitter(), events = [];
    await assert.rejects(withRailsLoadCleanup({ signals,
      run: async () => { events.push(phase); throw primary; },
      cleanup: async ({ primaryError, remaining }) => {
        events.push("cleanup"); assert.equal(primaryError, primary); assert.ok(remaining() <= 60_000);
      },
    }), error => error === primary);
    assert.deepEqual(events, [phase, "cleanup"]);
    assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0);
  }
});

test("cleanup failure denies success and preserves a simultaneous primary failure", async () => {
  for (const primary of [undefined, new Error("Rails failed")]) {
    const settlement = new Error("owned volume remains");
    await assert.rejects(withRailsLoadCleanup({ signals: new EventEmitter(),
      run: async () => { if (primary) throw primary; }, cleanup: async () => { throw settlement; },
    }), error => primary ? error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(settlement) : error === settlement);
  }
});

test("INT and TERM abort the active command and bound owned settlement without converting cancellation to success", async () => {
  for (const [signalName, budget] of [["SIGINT", 6000], ["SIGTERM", 2000]]) {
    const signals = new EventEmitter(); let cancelled, settled = 0;
    await assert.rejects(withRailsLoadCleanup({ signals,
      run: signal => new Promise((resolveCommand, reject) => {
        signal.addEventListener("abort", () => { cancelled = signal.aborted; reject(signal.reason); }, { once: true });
        setImmediate(() => signals.emit(signalName));
      }),
      cleanup: async ({ primaryError, remaining }) => {
        settled++; assert.match(primaryError.message, new RegExp(signalName));
        assert.ok(remaining() > 0 && remaining() <= budget);
      },
    }), new RegExp(signalName));
    assert.equal(cancelled, true); assert.equal(settled, 1);
    assert.equal(signals.listenerCount(signalName), 0);
  }
});

test("a signal aborts in-flight settlement and leaves a fresh bounded signal for subsequent cleanup", async () => {
  const signals = new EventEmitter(); let settled = 0;
  await assert.rejects(withRailsLoadCleanup({ signals, run: async () => {},
    cleanup: async ({ signal, remaining }) => {
      const active = signal();
      const pending = new Promise((resolveCommand, reject) => active.addEventListener("abort", () => reject(active.reason), { once: true }));
      setImmediate(() => signals.emit("SIGTERM"));
      await assert.rejects(pending, /SIGTERM/u);
      assert.equal(active.aborted, true); assert.equal(signal().aborted, false);
      assert.ok(remaining() > 0 && remaining() <= 2000);
      settled++;
    },
  }), /SIGTERM/u);
  assert.equal(settled, 1);
});

test("the cold-boot image target unpacks the exact package before optional frontend asset compilation", async () => {
  const dockerfile = await readFile(new URL("../infra/docker/Dockerfile.zammad", import.meta.url), "utf8");
  const source = dockerfile.indexOf(" AS package-source");
  const verify = dockerfile.indexOf("sha256sum --check --strict", source);
  const unpack = dockerfile.indexOf("node /tmp/unpack-zpm.mjs", verify);
  const assets = dockerfile.indexOf("FROM package-source AS package-build", unpack);
  assert.ok(source > 0 && verify > source && unpack > verify && assets > unpack);
  assert.ok(dockerfile.indexOf("pnpm install --frozen-lockfile", assets) > assets);
});
