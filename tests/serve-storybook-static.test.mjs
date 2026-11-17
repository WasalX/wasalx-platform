import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("Storybook static server serves files and rejects traversal on this platform", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-storybook-path-"));
  const root = join(directory, "static");
  await mkdir(root);
  await writeFile(join(root, "index.html"), "Storybook fixture");
  await writeFile(join(directory, "private.txt"), "must stay private");

  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));

  const child = spawn(process.execPath, ["scripts/serve-storybook-static.mjs"], {
    env: { ...process.env, WASALX_STORYBOOK_STATIC_DIR: root, WASALX_STORYBOOK_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    await new Promise((done, fail) => {
      const timeout = setTimeout(() => fail(new Error("Storybook server did not start")), 10_000);
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("listening")) { clearTimeout(timeout); done(); }
      });
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`Storybook server exited ${code}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const index = await fetch(`${base}/index.html`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), "Storybook fixture");
    const traversal = await fetch(`${base}/%2e%2e%2fprivate.txt`);
    assert.equal(traversal.status, 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    assert.equal(resolve(directory).startsWith(resolve(tmpdir()) + sep), true);
    await rm(directory, { recursive: true });
  }
});
