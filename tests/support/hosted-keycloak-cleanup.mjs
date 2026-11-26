import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, rm } from "node:fs/promises";

export async function cleanupKeycloakIdentity({ docker, image, container, callback, scratch, removeScratch = rm }) {
  const containerFilter = ["ps", "-aq", "--filter", "name=^/" + container + "$"];
  const imageFilter = ["image", "ls", "-q", image];
  const cleanups = [
    ["callback", async () => {
      if (callback.listening) {
        const closed = once(callback, "close");
        callback.close();
        await closed;
      }
      assert.equal(callback.listening, false);
    }],
    ["container", async () => {
      if (await docker(...containerFilter)) await docker("rm", "-f", container);
      assert.equal(await docker(...containerFilter), "");
    }],
    ["image-tag", async () => {
      if (await docker(...imageFilter)) await docker("image", "rm", image);
      assert.equal(await docker(...imageFilter), "");
    }],
    ["fixtures", async () => {
      if (!scratch) return;
      await removeScratch(scratch, { recursive: true, force: true });
      await assert.rejects(lstat(scratch), { code: "ENOENT" });
    }],
  ];
  const failures = [];
  for (const [name, cleanup] of cleanups) {
    try {
      await cleanup();
    } catch {
      failures.push(name);
    }
  }
  return failures;
}
