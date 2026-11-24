import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryDigestMatches } from "../installer-evidence.mjs";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const source = "https://github.com/WasalX/wasalx-platform";
const hostedPublisher = source + "/.github/workflows/branch-image.yml@refs/heads/main";
export const hostedIssuer = "https://token.actions.githubusercontent.com";
const digest = /^sha256:[0-9a-f]{64}$/u;

export function assertLocalRegistry(registry, environment = process.env) {
  const endpoint = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*):([1-9][0-9]{0,4})$/u.exec(registry ?? "");
  assert.ok(endpoint, "local registry requires a host and port");
  const [, host, port] = endpoint;
  assert.ok(Number(port) <= 65535, "invalid local registry port");
  const allowed = (environment.WASALX_LOCAL_REGISTRY_ALLOWLIST ?? "").split(",").map(value => value.trim());
  assert.ok(host === "localhost" || host === "127.0.0.1" || allowed.includes(registry),
    "local registry endpoint must be loopback or listed in WASALX_LOCAL_REGISTRY_ALLOWLIST");
}

export function localRegistryReference(registry, reference) {
  assertLocalRegistry(registry);
  const parts = (reference ?? "").split("@");
  assert.ok(parts.length === 2 && parts[0] && digest.test(parts[1]), "local registry requires a digest-pinned image");
  return `${registry}/staged/${parts[1].slice(7)}@${parts[1]}`;
}

export async function verifyStagedImage(execute, environment, reference) {
  const [details] = JSON.parse(await execute("docker", ["image", "inspect", reference], environment));
  assert.ok(details?.RepoDigests?.some(value => repositoryDigestMatches(reference, value)),
    "loaded local registry digest mismatch");
  return details;
}

function uniqueJson(bytes) {
  const value = JSON.parse(bytes);
  const tokens = bytes.toString().match(/"(?:[^"\\]|\\.)*"|[{}[\]:]/gu) ?? [];
  const objects = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "{" || token === "[") objects.push(token === "{" ? new Set() : null);
    else if (token === "}" || token === "]") objects.pop();
    else if (tokens[i + 1] === ":") {
      const key = JSON.parse(token), keys = objects.at(-1);
      assert.ok(!keys.has(key), "duplicate hosted JSON key"); keys.add(key);
    }
  }
  return value;
}

export async function readHostedInventory(context) {
  const bytes = await readFile(context.hostedImages);
  assert.equal(sha256(bytes), context.hostedImagesSha256, "hosted inventory bytes changed");
  const inventory = uniqueJson(bytes);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.repository, "WasalX/wasalx-platform");
  assert.equal(inventory.platform, "linux/amd64");
  assert.equal(inventory.commit, context.imageSource?.commit ?? context.candidateSha, "hosted source commit mismatch");
  assert.equal(inventory.tree, context.imageSource?.tree ?? context.candidateTree, "hosted source tree mismatch");
  assert.equal(inventory.publicationComplete, true, "incomplete hosted publication");
  assert.deepEqual(inventory.pending, {});
  assert.deepEqual(Object.keys(inventory.images).sort(), context.catalog.images.map(({ id }) => id).sort(), "complete unique hosted catalog required");
  const refs = new Set();
  for (const { id } of context.catalog.images) {
    const row = inventory.images[id];
    assert.equal(row.image, id, "hosted catalog name mismatch");
    assert.equal(row.commit, inventory.commit); assert.equal(row.tree, inventory.tree);
    assert.equal(row.platform, "linux/amd64");
    assert.equal(row.status, "published"); assert.equal(row.verified, true);
    assert.match(row.digest ?? "", digest); assert.match(row.configDigest ?? "", digest);
    assert.equal(row.pullReference, `ghcr.io/wasalx/${id}@${row.digest}`, "exact hosted digest reference required");
    assert.equal(row.workflow, hostedPublisher, "hosted publisher identity mismatch");
    assert.equal(row.inspection?.configDigest, row.configDigest, "hosted inventory config mismatch");
    assert.ok(!refs.has(row.pullReference), "duplicate hosted reference"); refs.add(row.pullReference);
  }
  return { ...inventory, publisher: hostedPublisher };
}

export function assertHostedStatement(statement, row) {
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v0.2");
  assert.equal(statement.subject?.length, 1, "unique hosted attestation subject required");
  assert.equal(statement.subject[0].name, `ghcr.io/wasalx/${row.image}`, "signed hosted image name mismatch");
  assert.equal(statement.subject[0].digest?.sha256, row.digest.slice(7), "hosted attestation manifest mismatch");
  const predicate = statement.predicate;
  assert.equal(predicate?.builder?.id, hostedPublisher, "hosted attestation publisher mismatch");
  assert.equal(predicate.buildType, `${source}/image-build/v1`);
  assert.deepEqual(predicate.materials, [{ uri: `git+${source}`, digest: { sha1: row.commit, gitTree: row.tree } }]);
  assert.deepEqual(predicate.invocation?.configSource, { uri: `git+${source}`, digest: { sha1: row.commit }, entryPoint: ".github/workflows/branch-image.yml" });
  for (const [key, expected] of Object.entries({ image: row.image, tree: row.tree, configDigest: row.configDigest })) {
    assert.equal(predicate.invocation.parameters?.[key], expected, `signed hosted ${key} mismatch`);
  }
}

export async function verifyHostedImages(context, { verifyOnly = false } = {}) {
  const inventory = await readHostedInventory(context);
  const execute = context.command;
  const version = JSON.parse(await execute("cosign", ["version", "--json"], context.environment));
  assert.equal(version.gitVersion, "v3.1.4", "hosted admission requires cosign v3.1.4");
  const rootBytes = await readFile(context.hostedTrustedRoot), trustedRootSha256 = sha256(rootBytes);
  const temporary = await mkdtemp(join(tmpdir(), "wasalx-hosted-verification-"));
  try {
    const root = join(temporary, "trusted-root.json");
    await writeFile(root, rootBytes, { mode: 0o600, flag: "wx" });
    const common = ["--offline", "--trusted-root", root,
      "--certificate-identity", inventory.publisher, "--certificate-oidc-issuer", hostedIssuer];
    const images = [];
    let verified = 0;
    for (const image of context.plan) {
      const row = inventory.images[image.id];
      assert.ok(row, "candidate missing from hosted inventory");
      const saved = resolve(context.hostedImages, "..", image.id);
      const raw = await readFile(resolve(saved, "manifest.json"));
      assert.equal(`sha256:${sha256(raw)}`, row.digest, "raw hosted manifest digest mismatch");
      const manifest = uniqueJson(raw);
      assert.ok(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].includes(manifest.mediaType), "single-platform hosted manifest required");
      assert.equal(manifest.config?.digest, row.configDigest, "hosted manifest config mismatch");
      const seals = {};
      for (const [name, type] of [["signature", "https://sigstore.dev/cosign/sign/v1"], ["provenance", "https://slsa.dev/provenance/v0.2"]]) {
        const bytes = await readFile(resolve(saved, `${name}.sigstore.json`));
        const bundle = uniqueJson(bytes), envelope = bundle.dsseEnvelope;
        assert.equal(bundle.mediaType, "application/vnd.dev.sigstore.bundle.v0.3+json");
        assert.equal(envelope.payloadType, "application/vnd.in-toto+json");
        const statement = uniqueJson(Buffer.from(envelope.payload, "base64"));
        assert.equal(statement.predicateType, type);
        assert.equal(statement.subject?.length, 1);
        assert.equal(statement.subject[0].digest?.sha256, row.digest.slice(7), "signed hosted manifest mismatch");
        if (name === "provenance") assertHostedStatement(statement, row);
        // Verify the same private snapshot we parsed, never a replaceable caller file.
        const path = join(temporary, `${image.id}-${name}.json`);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        await execute("cosign", ["verify-blob-attestation", ...common, "--certificate-github-workflow-sha", row.commit,
          "--bundle", path, "--type", type, "--digest", row.digest.slice(7), "--digestAlg", "sha256"], context.environment);
        seals[name] = sha256(bytes);
      }
      verified += 1;
      if (verifyOnly) continue;
      const inspect = async () => JSON.parse(await execute("docker", ["image", "inspect", image.reference], context.environment))[0];
      const before = await inspect();
      assert.ok([row.digest, row.configDigest].includes(before?.Id), "loaded hosted image identity mismatch");
      if (context.localRegistry) {
        const staged = await verifyStagedImage(execute, context.environment, localRegistryReference(context.localRegistry, row.pullReference));
        assert.equal(before.Id, staged.Id, "hosted alias does not identify its staged digest");
      }
      const loaded = JSON.parse(await execute("python3", [resolve(context.repository, "scripts/release/images-by-digest.py"),
        "loaded-config", "--image", image.reference, "--config-digest", row.configDigest], context.environment));
      assert.equal(loaded.configDigest, row.configDigest, "loaded hosted config mismatch");
      assert.equal(loaded.config?.os, "linux"); assert.equal(loaded.config?.architecture, "amd64");
      const after = await inspect();
      assert.equal(after?.Id, before.Id, "loaded hosted image changed during admission");
      for (const labels of [loaded.config?.config?.Labels, before.Config?.Labels, after.Config?.Labels]) {
        assert.equal(labels?.["org.opencontainers.image.source"], source, "loaded hosted source mismatch");
        assert.equal(labels?.["org.opencontainers.image.revision"], row.commit, "loaded hosted revision mismatch");
        assert.equal(labels?.["io.wasalx.source.tree"], row.tree, "loaded hosted tree mismatch");
      }
      images.push({ ...image, imageId: before.Id, state: "ADMITTED", sourceReference: row.pullReference,
        manifestDigest: row.digest, configDigest: row.configDigest,
        signatureSha256: seals.signature, attestationSha256: seals.provenance });
    }
    assert.equal(verified, context.catalog.images.length, "complete hosted candidate plan required");
    assert.equal(new Set(context.plan.map(({ id }) => id)).size, verified, "duplicate hosted candidate plan");
    assert.equal(sha256(await readFile(context.hostedTrustedRoot)), trustedRootSha256, "hosted trust root changed");
    return { images, trustedRootSha256, publisher: inventory.publisher };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
