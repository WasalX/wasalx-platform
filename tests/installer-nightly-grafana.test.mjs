import assert from "node:assert/strict";
import test from "node:test";
import { checkGrafanaJaeger } from "../scripts/release/installer-nightly-grafana.mjs";

const prefix = "/api/datasources/uid/jaeger";
const compose = { services: { grafana: {
  ports: [{ target: 3000, host_ip: "127.0.0.1", published: "3002" }],
  environment: { GF_SECURITY_ADMIN_USER: "fixture-admin", GF_SECURITY_ADMIN_PASSWORD: "fixture-password" },
} } };
const auth = Buffer.from("fixture-admin:fixture-password").toString("base64");

function grafana(t, health, services) {
  const paths = [];
  const masks = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const { origin, pathname } = new URL(url);
    paths.push(pathname);
    if (origin !== "http://127.0.0.1:3002" || options.headers.Authorization !== `Basic ${auth}` ||
      options.redirect !== "manual" || !masks.includes(auth)) return new Response(null, { status: 401 });
    if (pathname === prefix) return Response.json({ type: "jaeger", url: "http://jaeger:16686" });
    if (pathname === `${prefix}/health`) return health;
    if (pathname === `${prefix}/resources/services`) return services;
    return new Response(null, { status: 404 });
  });
  return { paths, masks, run: () => checkGrafanaJaeger(compose, (value) => masks.push(value)) };
}

test("Grafana Jaeger smoke accepts an empty service list and masks credentials before requests", async (t) => {
  const { run, paths, masks } = grafana(t, Response.json({ status: "OK" }), Response.json([]));
  await run();
  assert.deepEqual(paths, [prefix, `${prefix}/health`, `${prefix}/resources/services`]);
  assert.deepEqual(masks, ["fixture-admin", "fixture-password", auth]);
});

test("Grafana Jaeger smoke reports both HTTP failures without leaking response bodies", async (t) => {
  const { run } = grafana(t, new Response("private error", { status: 400 }), new Response("private error", { status: 500 }));
  await assert.rejects(run(), { message: `${prefix}/health returned HTTP 400, ${prefix}/resources/services returned HTTP 500` });
});

test("Grafana Jaeger smoke rejects HTTP success with unhealthy status and a wrong services shape", async (t) => {
  const { run } = grafana(t, Response.json({ status: "ERROR" }), Response.json({ data: [] }));
  await assert.rejects(run(), { message: `${prefix}/health returned an unexpected body, ${prefix}/resources/services returned an unexpected body` });
});
