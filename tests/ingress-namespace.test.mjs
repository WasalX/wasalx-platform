import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderProductionIngress } from "../scripts/release/render-production-ingress.mjs";

test("missing or malformed deployment identity is rejected", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-ingress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fragment = join(directory, "ingress.json");
  await writeFile(fragment, JSON.stringify({ ingress: [] }));
  t.mock.property(process, "env", { ...process.env, WASALX_INGRESS_FRAGMENT: pathToFileURL(fragment).href });
  const input = { namespace: "example-ns" };
  assert.doesNotThrow(() => renderProductionIngress(input));

  for (const namespace of [undefined, "", "../default", "a.b", "A", "a".repeat(64)]) {
    assert.throws(() => renderProductionIngress({ ...input, namespace }), /A Kubernetes application namespace is required/u);
  }
});
