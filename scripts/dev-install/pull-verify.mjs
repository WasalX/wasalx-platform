import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
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

if (import.meta.main) {
  const [hostedImages, candidateSha, candidateTree, cosign, trustedRoot, trustedRootSha256] = process.argv.slice(2);
  const catalog = JSON.parse(await readFile(new URL("../../release/installer-images.json", import.meta.url)));
  const hostedImagesSha256 = createHash("sha256").update(await readFile(hostedImages)).digest("hex");
  const inventory = await readHostedInventory({ hostedImages, candidateSha, candidateTree, catalog, hostedImagesSha256 });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(cosign)) hash.update(chunk);
  assert.equal(hash.digest("hex"), "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa");
  const trustBytes = await readFile(trustedRoot);
  assert.equal(createHash("sha256").update(trustBytes).digest("hex"), trustedRootSha256);
  const trust = join(dirname(hostedImages), "trusted-root.json");
  await writeFile(trust, trustBytes, { mode: 0o600, flag: "wx" });
  const run = promisify(execFile);
  const refs = await verifyProductDigests(inventory, trust, async args =>
    (await run(cosign, args, { timeout: 30000 })).stdout);
  console.log(JSON.stringify(refs));
}
