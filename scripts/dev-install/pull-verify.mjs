import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import cosignPin from "../release/cosign-pin.json" with { type: "json" };
import { assertHostedStatement, hostedIssuer, readHostedInventory } from "../release/installer-hosted-images.mjs";

export async function verifyProductDigests(inventory, trust, execute) {
  const common = ["--trusted-root", trust, "--certificate-identity", inventory.publisher,
    "--certificate-oidc-issuer", hostedIssuer, "--certificate-github-workflow-sha", inventory.commit];
  const refs = [];
  for (const row of Object.values(inventory.images)) {
    const ref = row.pullReference;
    await execute(["verify", ...common, ref]);
    const attestations = await execute(["verify-attestation", ...common, "--type", "slsaprovenance", ref]);
    for (const line of attestations.trim().split(/\r?\n/u)) {
      const envelope = JSON.parse(line);
      assert.equal(envelope.payloadType, "application/vnd.in-toto+json");
      const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
      assert.equal(statement.subject?.[0]?.digest?.sha256, row.digest.slice(7), "signed hosted manifest mismatch");
      assertHostedStatement(statement, row);
    }
    refs.push(ref);
  }
  return refs;
}

const run = promisify(execFile);
const timeout = 30_000;

function cosignReason(error) {
  if (error.killed) return "verification exceeded the 30-second command deadline";
  if (error.code === "ENOENT") return "executable not found";
  if (error.code === "EACCES") return "executable permission denied";
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "verification output exceeded the command buffer";
  if (error.signal) return "verification process terminated by a signal";
  // Registry errors can contain authorization headers and signed URLs. Emit only known reasons.
  const stderr = String(error.stderr ?? "");
  if (/TLS handshake timeout|i\/o timeout|context deadline exceeded/u.test(stderr)) return "registry or Sigstore request timed out";
  if (/unexpected EOF|connection reset by peer|connection refused/u.test(stderr)) return "registry or Sigstore connection failed";
  const status = stderr.match(/(?:unexpected status code|HTTP status|HTTP response)[: ]+([45]\d\d)\b/iu);
  if (status) return `registry or Sigstore returned HTTP ${status[1]}`;
  if (/UNAUTHORIZED|DENIED|TOOMANYREQUESTS|MANIFEST_UNKNOWN/u.test(stderr)) {
    return "registry denied or could not resolve the anonymous digest request";
  }
  if (/no matching (signatures|attestations)|no (signatures|attestations) found/u.test(stderr)) {
    return "no matching signature or attestation";
  }
  return "signature or provenance verification failed";
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [hostedImages, candidateSha, candidateTree, cosign, trustedRoot, trustedRootSha256] = process.argv.slice(2);
  let command = "node scripts/dev-install/pull-verify.mjs";
  let reason = "cannot load or validate the hosted image inventory";
  try {
    const catalog = JSON.parse(await readFile(new URL("../../release/installer-images.json", import.meta.url)));
    const hostedImagesSha256 = createHash("sha256").update(await readFile(hostedImages)).digest("hex");
    const inventory = await readHostedInventory({ hostedImages, candidateSha, candidateTree, catalog, hostedImagesSha256 });
    reason = "cannot read or validate the pinned Cosign binary";
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(cosign)) hash.update(chunk);
    assert.equal(hash.digest("hex"), cosignPin.linuxAmd64Sha256);
    reason = "cannot read or validate the pinned Sigstore trust root";
    const trustBytes = await readFile(trustedRoot);
    assert.equal(createHash("sha256").update(trustBytes).digest("hex"), trustedRootSha256);
    reason = "cannot create the private verification trust root";
    const trust = join(dirname(hostedImages), "trusted-root.json");
    await writeFile(trust, trustBytes, { mode: 0o600, flag: "wx" });
    reason = "cannot decode or validate the signed provenance";
    const refs = await verifyProductDigests(inventory, trust, async args => {
      try {
        return (await run(cosign, args, { timeout })).stdout;
      } catch (error) {
        command = `cosign ${args[0]} ${args.at(-1)}`;
        reason = cosignReason(error);
        throw error;
      }
    });
    console.log(JSON.stringify(refs));
  } catch (error) {
    const exit = Number.isInteger(error.code) ? error.code : error.killed ? 124 : 1;
    // Only explicit identity mismatches are useful here. Assertion values can contain arbitrary input.
    const mismatch = /^(hosted source (?:commit|tree) mismatch|signed hosted [a-zA-Z ]+ mismatch)$/u;
    if (error.code === "ERR_ASSERTION" && mismatch.test(error.message)) reason += ` (${error.message})`;
    console.error(`command=${command} exit=${exit} reason=${reason}`);
    process.exitCode = exit;
  }
}
