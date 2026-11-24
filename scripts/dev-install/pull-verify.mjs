import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import cosignPin from "../release/cosign-pin.json" with { type: "json" };
import { readHostedInventory, verifyHostedImages } from "../release/installer-hosted-images.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;
const run = promisify(execFile);

export function pullCommandTimeout(stage, elapsedMs) {
  // Leave time to report the failing stage before the pull agent's 300-second watchdog.
  const remaining = Math.floor(290_000 - elapsedMs);
  if (remaining <= 0) throw Object.assign(new Error("pull verification deadline expired"), { code: 124 });
  return Math.min(stage === "staging" ? 240_000 : 30_000, remaining);
}

function cosignReason(error) {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "verification output exceeded the command buffer";
  if (error.killed || error.code === 124) return "offline verification deadline expired";
  if (error.code === "ENOENT") return "executable not found";
  if (error.code === "EACCES") return "executable permission denied";
  if (error.signal) return "verification process terminated by a signal";
  return "offline signature or provenance verification failed";
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const started = performance.now();
  const timeoutFor = stage => pullCommandTimeout(stage, performance.now() - started);
  const [hostedImages, candidateSha, candidateTree, cosign, trustedRoot, trustedRootSha256, source] = process.argv.slice(2);
  let command = "node scripts/dev-install/pull-verify.mjs";
  let reason = "cannot load or validate the hosted image inventory";
  try {
    const catalog = JSON.parse(await readFile(new URL("../../release/installer-images.json", import.meta.url)));
    const hostedImagesSha256 = createHash("sha256").update(await readFile(hostedImages)).digest("hex");
    const context = { hostedImages, candidateSha, candidateTree, catalog, hostedImagesSha256, plan: catalog.images,
      hostedTrustedRoot: trustedRoot, hostedTrustedRootSha256: trustedRootSha256 };
    // Bind the public manifest before it can select network requests.
    await readHostedInventory(context);
    reason = "cannot read or validate the pinned Cosign binary";
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(cosign)) hash.update(chunk);
    assert.equal(hash.digest("hex"), cosignPin.linuxAmd64Sha256);
    reason = "cannot read or validate the pinned Sigstore trust root";
    const trustBytes = await readFile(trustedRoot);
    assert.equal(createHash("sha256").update(trustBytes).digest("hex"), trustedRootSha256);

    if (source !== "--staged") {
      const stager = fileURLToPath(new URL("../release/installer-hosted-bundles.py", import.meta.url));
      try {
        await run("python3", ["-I", "-B", stager, hostedImages], { timeout: timeoutFor("staging"), killSignal: "SIGKILL" });
      } catch (error) {
        command = "python3 -I -B scripts/release/installer-hosted-bundles.py";
        if (error.killed || error.code === 124) reason = "public manifest and Sigstore bundle staging deadline expired";
        else reason = error.stderr?.match(/^hosted bundle staging reason: ([a-zA-Z0-9 /:._=()-]{1,480})$/mu)?.[1]
          ?? "cannot acquire the public manifest and Sigstore bundles";
        throw error;
      }
    }

    reason = "cannot validate the staged manifest, signature or provenance";
    const { references } = await verifyHostedImages({ ...context, command: async (_tool, args) => {
      const operation = args[0], commandStarted = performance.now();
      const digest = args[args.indexOf("--digest") + 1];
      try {
        return (await run(cosign, args, { timeout: timeoutFor("cosign"), killSignal: "SIGKILL" })).stdout;
      } catch (error) {
        command = DIGEST.test(digest) ? `cosign ${operation} sha256:${digest}` : `cosign ${operation}`;
        reason = cosignReason(error);
        throw error;
      } finally {
        if (source === "--staged" && operation === "verify-blob-attestation") {
          console.error(`cosign-offline operation=${operation} digest=sha256:${digest} elapsed_ms=${Math.ceil(performance.now() - commandStarted)}`);
        }
      }
    } }, { verifyOnly: true });
    console.log(JSON.stringify(references));
  } catch (error) {
    const exit = Number.isInteger(error.code) ? error.code : error.killed ? 124 : 1;
    // Only explicit identity mismatches are useful here. Assertion values can contain arbitrary input.
    const mismatch = /^(hosted source (?:commit|tree) mismatch|signed hosted [a-zA-Z ]+ mismatch)$/u;
    const message = error.code === "ERR_ASSERTION" ? error.message.split(/\r?\n/u, 1)[0] : "";
    if (mismatch.test(message)) reason += ` (${message})`;
    console.error(`command=${command} exit=${exit} reason=${reason}`);
    process.exitCode = exit;
  }
}
