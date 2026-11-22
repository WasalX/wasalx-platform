import assert from "node:assert/strict";
import test from "node:test";
import { verifyProductDigests } from "../scripts/dev-install/pull-verify.mjs";

const source = "https://github.com/WasalX/wasalx-platform";
const publisher = source + "/.github/workflows/branch-image.yml@refs/heads/main";
const commit = "a".repeat(40), tree = "b".repeat(40);
const digest = "sha256:" + "c".repeat(64), configDigest = "sha256:" + "d".repeat(64);
const name = "ghcr.io/wasalx/portal", ref = name + "@" + digest;
const inventory = { publisher, commit, images: {
  portal: { image: "portal", commit, tree, digest, configDigest, pullReference: ref },
} };

function envelope(gitTree) {
  const statement = {
    predicateType: "https://slsa.dev/provenance/v0.2",
    subject: [{ name, digest: { sha256: digest.slice(7) } }],
    predicate: {
      builder: { id: publisher }, buildType: source + "/image-build/v1",
      materials: [{ uri: "git+" + source, digest: { sha1: commit, gitTree } }],
      invocation: {
        configSource: { uri: "git+" + source, digest: { sha1: commit }, entryPoint: ".github/workflows/branch-image.yml" },
        parameters: { image: "portal", tree, configDigest },
      },
    },
  };
  return JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
  }) + "\n";
}

test("the pull verifier uses only pinned signature and attestation operations", async () => {
  const calls = [];
  const refs = await verifyProductDigests(inventory, "trust.json", async args => {
    calls.push(args);
    return args[0] === "verify-attestation" ? envelope(tree) : "";
  });
  const trust = ["--trusted-root", "trust.json", "--certificate-identity", publisher,
    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", "--certificate-github-workflow-sha", commit];
  assert.deepEqual(calls, [
    ["verify", ...trust, ref],
    ["verify-attestation", ...trust, "--type", "slsaprovenance", ref],
  ]);
  assert.deepEqual(refs, [ref]);
});

test("a successfully signed attestation for another tree cannot qualify", async () => {
  const otherTree = "e".repeat(40);
  await assert.rejects(verifyProductDigests(inventory, "trust.json", async () => envelope(otherTree)), error =>
    error.code === "ERR_ASSERTION" && error.actual[0].digest.gitTree === otherTree && error.expected[0].digest.gitTree === tree);
});
