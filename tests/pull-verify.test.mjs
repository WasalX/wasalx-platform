import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import cosignPin from "../scripts/release/cosign-pin.json" with { type: "json" };
import { hostedIssuer, verifyHostedImages } from "../scripts/release/installer-hosted-images.mjs";

const source = "https://github.com/WasalX/wasalx-platform";
const publisher = source + "/.github/workflows/branch-image.yml@refs/heads/main";
const commit = "a".repeat(40), tree = "b".repeat(40);
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const configDigest = "sha256:" + "d".repeat(64);
const name = "ghcr.io/wasalx/portal";
const signature = "https://sigstore.dev/cosign/sign/v1";
const provenance = "https://slsa.dev/provenance/v0.2";

async function fixture(t, signedTree = tree) {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-pull-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = join(directory, "portal");
  const hostedTrustedRoot = join(directory, "root.json");
  const hostedImages = join(directory, "images-manifest.json");
  const manifest = JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: configDigest } });
  const digestHex = hash(manifest), digest = "sha256:" + digestHex;
  const pullReference = name + "@" + digest;
  const subject = [{ name, digest: { sha256: digestHex } }];
  const row = { image: "portal", commit, tree, digest, configDigest, pullReference, platform: "linux/amd64",
    status: "published", verified: true, workflow: publisher, inspection: { configDigest } };
  const inventory = JSON.stringify({ schemaVersion: 1, repository: "WasalX/wasalx-platform", platform: "linux/amd64",
    commit, tree, publicationComplete: true, pending: {}, images: { portal: row } });
  const plan = [{ id: "portal" }];
  const bundle = (type, predicate = {}) => JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: { payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify({ predicateType: type, subject, predicate })).toString("base64") } });
  await mkdir(saved);
  await Promise.all([
    writeFile(hostedImages, inventory),
    writeFile(hostedTrustedRoot, "fixture trust root"),
    writeFile(join(saved, "manifest.json"), manifest),
    writeFile(join(saved, "signature.sigstore.json"), bundle(signature)),
    writeFile(join(saved, "provenance.sigstore.json"), bundle(provenance, {
      builder: { id: publisher }, buildType: source + "/image-build/v1",
      materials: [{ uri: "git+" + source, digest: { sha1: commit, gitTree: signedTree } }],
      invocation: {
        configSource: { uri: "git+" + source, digest: { sha1: commit }, entryPoint: ".github/workflows/branch-image.yml" },
        parameters: { image: "portal", tree, configDigest },
      },
    })),
  ]);
  const calls = [];
  const context = { hostedImages, hostedImagesSha256: hash(inventory), hostedTrustedRoot,
    hostedTrustedRootSha256: hash("fixture trust root"), candidateSha: commit, candidateTree: tree, catalog: { images: plan }, plan,
    command: async (tool, args) => {
      assert.equal(tool, "cosign");
      calls.push(args);
      if (args[0] === "version") return JSON.stringify({ gitVersion: cosignPin.version });
      assert.equal(await readFile(args[args.indexOf("--trusted-root") + 1], "utf8"), "fixture trust root");
      return "";
    } };
  return { context, calls, pullReference, digestHex };
}

test("the pull verifier checks the staged signature and attestation offline with pinned identity and digest", async t => {
  const { context, calls, pullReference, digestHex } = await fixture(t);
  const { references } = await verifyHostedImages(context, { verifyOnly: true });
  assert.deepEqual(references, [pullReference]);
  assert.deepEqual(calls[0], ["version", "--json"]);
  assert.equal(calls.length, 3);
  for (const [args, type] of [[calls[1], signature], [calls[2], provenance]]) {
    assert.equal(args[0], "verify-blob-attestation");
    assert.ok(args.includes("--offline"));
    assert.equal(args[args.indexOf("--certificate-identity") + 1], publisher);
    assert.equal(args[args.indexOf("--certificate-oidc-issuer") + 1], hostedIssuer);
    assert.equal(args[args.indexOf("--certificate-github-workflow-sha") + 1], commit);
    assert.equal(args[args.indexOf("--digest") + 1], digestHex);
    assert.equal(args[args.indexOf("--type") + 1], type);
    assert.ok(!args.includes(pullReference));
  }
});

test("a staged attestation for another tree cannot qualify", async t => {
  const otherTree = "e".repeat(40);
  const { context } = await fixture(t, otherTree);
  await assert.rejects(verifyHostedImages(context, { verifyOnly: true }), error =>
    error.code === "ERR_ASSERTION" && error.actual[0].digest.gitTree === otherTree && error.expected[0].digest.gitTree === tree);
});

test("the pull verifier rejects a changed trusted root before checking either bundle", async t => {
  const { context, calls } = await fixture(t);
  await writeFile(context.hostedTrustedRoot, "another root");
  await assert.rejects(verifyHostedImages(context, { verifyOnly: true }), /Sigstore trust root checksum mismatch/u);
  assert.deepEqual(calls, [["version", "--json"]]);
});

test("the verifier CLI reports inventory failure without leaking its arguments", () => {
  const verifier = fileURLToPath(new URL("../scripts/dev-install/pull-verify.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [verifier, "private-fixture-manifest"], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^command=node scripts\/dev-install\/pull-verify\.mjs exit=1 reason=cannot load or validate the hosted image inventory\s*$/u);
  assert.ok(!result.stderr.includes("private-fixture-manifest"));
});
