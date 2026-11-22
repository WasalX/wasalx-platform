import assert from "node:assert/strict";
import test from "node:test";
import { checkGrafanaJaeger } from "../scripts/release/installer-nightly-grafana.mjs";

const prefix = "/api/datasources/uid/jaeger";
const compose = ["compose", "--project-name", "fixture-nightly"];

function grafana(health, services) {
  const paths = [];
  const execute = async (command, args, options) => {
    const url = args.at(-1);
    const { origin, pathname } = new URL(url);
    paths.push(pathname);
    assert.equal(command, "docker");
    assert.deepEqual(args.slice(0, -1), [...compose, "exec", "-T", "grafana", "curl",
      "--disable", "--silent", "--max-time", "10",
      "--variable", "%GF_SECURITY_ADMIN_USER", "--variable", "%GF_SECURITY_ADMIN_PASSWORD",
      "--expand-user", "{{GF_SECURITY_ADMIN_USER}}:{{GF_SECURITY_ADMIN_PASSWORD}}",
      "--write-out", "\n%{http_code}",
    ]);
    assert.equal(origin, "http://127.0.0.1:3000");
    assert.equal(options.timeout, 10_000);
    const responses = {
      [prefix]: [200, { type: "jaeger", url: "http://jaeger:16686" }],
      [`${prefix}/health`]: health,
      [`${prefix}/resources/services`]: services,
    };
    const [status, body] = responses[pathname];
    return `${JSON.stringify(body)}\n${status}`;
  };
  return { paths, run: () => checkGrafanaJaeger(compose, execute) };
}

test("Grafana Jaeger smoke probes container loopback and accepts an empty service list", async () => {
  const { run, paths } = grafana([200, { status: "OK" }], [200, []]);
  await run();
  assert.deepEqual(paths, [prefix, `${prefix}/health`, `${prefix}/resources/services`]);
});

test("Grafana Jaeger smoke reports both HTTP failures without leaking response bodies", async () => {
  const { run } = grafana([400, "private error"], [500, "private error"]);
  await assert.rejects(run(), { message: `${prefix}/health returned HTTP 400, ${prefix}/resources/services returned HTTP 500` });
});

test("Grafana Jaeger smoke rejects HTTP success with unhealthy status and a wrong services shape", async () => {
  const { run } = grafana([200, { status: "ERROR" }], [200, { data: [] }]);
  await assert.rejects(run(), { message: `${prefix}/health returned an unexpected body, ${prefix}/resources/services returned an unexpected body` });
});

test("Grafana Jaeger smoke reports transport failure without logging the command error", async (t) => {
  const execute = t.mock.fn(async () => { throw new Error("private command output"); });
  await assert.rejects(checkGrafanaJaeger(compose, execute), { message: `${prefix} was unreachable or timed out` });
  assert.equal(execute.mock.callCount(), 1);
});
