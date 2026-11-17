import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostedPublisher, hostedIssuer, verifyHostedImages } from "../scripts/release/installer-hosted-images.mjs";
import { artifactPath, preimagePath, preserveReplacement, readBoundArtifacts, sha256 } from "../scripts/release/installer-artifacts.mjs";
import { createCandidatePlan, executeStage } from "../scripts/release/installer-stages.mjs";

const catalog = JSON.parse(await readFile(new URL("../release/installer-images.json", import.meta.url)));
const candidateSha = "a".repeat(40), candidateTree = "b".repeat(40);
const source = "https://github.com/WasalX/wasalx-platform";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hosted-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "source"), directory = join(root, "evidence"), privateDirectory = join(root, "private");
  await mkdir(repository); await mkdir(directory);
  const context = { repository, directory, privateDirectory, project: "fixture", candidateSha, candidateTree,
    catalog, catalogSha256: sha256(JSON.stringify(catalog)), environment: {},
    hostedImages: join(root, "images-manifest.json"), hostedTrustedRoot: join(root, "trusted-root.json"),
    model: { services: { portal: { image: "wasalx/portal:local", build: { context: repository, dockerfile: "Dockerfile.portal" } } } },
    composeArguments: ["compose", "--project-name", "fixture"] };
  context.plan = createCandidatePlan(catalog, context.model);
  await writeFile(context.hostedTrustedRoot, "synthetic trusted root");
  const inventory = { schemaVersion: 1, repository: "WasalX/wasalx-platform", platform: "linux/amd64",
    commit: candidateSha, tree: candidateTree, publicationComplete: true, pending: {}, images: {} };
  const configs = {}, manifests = {}, details = {}, statements = {}, signatures = {}, calls = [];
  for (const image of context.plan) {
    const config = { os: "linux", architecture: "amd64", config: { Labels: {
      "org.opencontainers.image.source": source, "org.opencontainers.image.revision": candidateSha,
      "io.wasalx.source.tree": candidateTree, "fixture.image": image.id } } };
    configs[image.id] = config;
    const configDigest = `sha256:${sha256(JSON.stringify(config))}`;
    const raw = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: configDigest } });
    const digest = `sha256:${sha256(raw)}`;
    const row = { image: image.id, commit: candidateSha, tree: candidateTree, platform: "linux/amd64",
      digest, configDigest, pullReference: `ghcr.io/wasalx/${image.id}@${digest}`, workflow: hostedPublisher,
      inspection: { configDigest }, status: "published", verified: true };
    inventory.images[image.id] = row;
    const path = join(root, image.id, "manifest.json");
    await mkdir(join(root, image.id)); await writeFile(path, raw);
    manifests[image.id] = { path, raw };
    details[image.reference] = { Id: digest, Config: config.config };
    signatures[image.id] = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: { certificate: { Subject: hostedPublisher, Issuer: hostedIssuer } },
      dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify({ predicateType: "https://sigstore.dev/cosign/sign/v1", subject: [{ digest: { sha256: digest.slice(7) } }] })).toString("base64") } };
    statements[image.id] = { predicateType: "https://slsa.dev/provenance/v0.2", subject: [{ name: `ghcr.io/wasalx/${image.id}`, digest: { sha256: digest.slice(7) } }],
      predicate: { builder: { id: hostedPublisher }, buildType: `${source}/image-build/v1`,
        materials: [{ uri: `git+${source}`, digest: { sha1: candidateSha, gitTree: candidateTree } }],
        invocation: { configSource: { uri: `git+${source}`, digest: { sha1: candidateSha }, entryPoint: ".github/workflows/branch-image.yml" },
          parameters: { image: image.id, tree: candidateTree, configDigest } } } };
  }
  const save = async (text = JSON.stringify(inventory)) => {
    await writeFile(context.hostedImages, text); context.hostedImagesSha256 = sha256(text);
    for (const image of context.plan) {
      await writeFile(join(root, image.id, "signature.sigstore.json"), JSON.stringify(signatures[image.id]));
      await writeFile(join(root, image.id, "provenance.sigstore.json"), JSON.stringify({
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: signatures[image.id].verificationMaterial,
        dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statements[image.id])).toString("base64") } }));
    }
  };
  await save();
  context.command = async (name, args) => {
    calls.push({ name, args });
    if (name === "cosign") {
      if (args[0] === "version") return JSON.stringify({ gitVersion: "v3.1.4" });
      assert.equal(args[0], "verify-blob-attestation");
      assert.ok(args.includes("--offline") && args.includes("--trusted-root"));
      assert.equal(args[args.indexOf("--certificate-identity") + 1], hostedPublisher);
      assert.equal(args[args.indexOf("--certificate-oidc-issuer") + 1], hostedIssuer);
      assert.ok(!args.some(arg => arg.includes("regexp") || arg.includes("insecure")));
      const bundle = JSON.parse(await readFile(args[args.indexOf("--bundle") + 1]));
      assert.equal(bundle.verificationMaterial.certificate.Subject, hostedPublisher, "cosign certificate identity rejected");
      assert.equal(bundle.verificationMaterial.certificate.Issuer, hostedIssuer, "cosign certificate issuer rejected");
      return "";
    }
    if (name === "python3") {
      assert.equal(args[1], "loaded-config");
      const image = context.plan.find(image => image.reference === args[3]);
      return JSON.stringify({ configDigest: inventory.images[image.id].configDigest, config: configs[image.id] });
    }
    assert.equal(name, "docker");
    if (args[0] === "info") return JSON.stringify({ ID: "engine", Name: "fixture", DockerRootDir: root });
    if (args[0] === "ps") return "";
    if (args[0] === "compose" && args[1] === "version") return "2.40.3";
    if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([details[args[2]]]);
    if (args[0] === "image" && args[1] === "ls") return "";
    if (args[0] === "build") {
      const image = context.plan.find(image => image.reference === args[args.indexOf("--tag") + 1]);
      const labels = Object.fromEntries(args.flatMap((arg, i) => arg === "--label" ? [args[i + 1].split(/=(.*)/su).slice(0, 2)] : []));
      details[image.reference].Config = { Labels: labels }; return 0;
    }
    assert.fail(`unexpected side effect: ${args[0]}`);
  };
  await preserveReplacement(context); calls.length = 0;
  return { context, inventory, configs, manifests, statements, signatures, details, calls, save };
}

test("hosted main identity is admitted with containerd manifest IDs and a distinct bound receipt", async t => {
  const f = await fixture(t);
  assert.equal(await executeStage("admit-hosted", f.context), 0);
  const { manifest, snapshot } = await readBoundArtifacts(f.context);
  assert.equal(manifest.kind, "compose-hosted-image-admission");
  assert.ok(manifest.images.every(image => image.state === "ADMITTED" && image.imageId === image.manifestDigest));
  assert.equal(manifest.buildContextAlgorithm, undefined); assert.equal(manifest.buildContextSha256, undefined);
  assert.equal(manifest.preimage.transactionId, snapshot.transactionId);
  assert.match(artifactPath(f.context), /hosted-admission-fixture.json$/u);
  assert.deepEqual(snapshot.buildTags.map(({ reference }) => reference), f.context.plan.map(({ reference }) => reference));
  assert.ok(f.calls.every(({ args }) => !args.includes("build") && !args.includes("pull") && !args.includes("load") && !args.includes("up")));
  f.calls.length = 0;
  await assert.rejects(executeStage("replace", f.context), /replace requires --drained/u);
  assert.ok(f.calls.every(({ args }) => !args.includes("stop") && !args.includes("up")));
  f.calls.length = 0;
  assert.equal(await executeStage("rollback", { ...f.context, drained: true }), 0);
  assert.ok(f.calls.every(({ name }) => name === "docker"), "rollback must not depend on candidate verification");
});

const refusals = {
  "wrong identity": f => { f.signatures.zammad.verificationMaterial.certificate.Subject = hostedPublisher.replace("main", "other"); },
  "missing identity": f => { delete f.signatures.zammad.verificationMaterial.certificate.Subject; },
  "wrong issuer": f => { f.signatures.zammad.verificationMaterial.certificate.Issuer = "https://example.invalid"; },
  "missing issuer": f => { delete f.signatures.zammad.verificationMaterial.certificate.Issuer; },
  "tag only": f => { f.inventory.images.zammad.pullReference = "ghcr.io/wasalx/zammad:main"; },
  "tag plus digest": f => { f.inventory.images.zammad.pullReference = f.inventory.images.zammad.pullReference.replace("@", ":main@"); },
  "wrong catalog name": f => { f.inventory.images.zammad.image = "portal"; },
  "partial coverage": f => { delete f.inventory.images.portal; },
  "signed config mismatch": f => { f.statements.zammad.predicate.invocation.parameters.configDigest = `sha256:${"c".repeat(64)}`; },
  "signed source mismatch": f => { f.statements.zammad.predicate.materials[0].digest.gitTree = "c".repeat(40); },
  "loaded config mismatch": f => { f.configs.zammad.config.Labels["io.wasalx.source.tree"] = "c".repeat(40); },
  "raw manifest mismatch": f => writeFile(f.manifests.zammad.path, f.manifests.zammad.raw + " "),
  "manifest config mismatch": async f => {
    const row = f.inventory.images.zammad, raw = JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: `sha256:${"c".repeat(64)}` } });
    row.digest = `sha256:${sha256(raw)}`; row.pullReference = `ghcr.io/wasalx/zammad@${row.digest}`;
    await writeFile(f.manifests.zammad.path, raw);
  },
};
for (const [reason, mutate] of Object.entries(refusals)) test(`hosted ${reason} rejects before admission and replacement side effects`, async t => {
  const f = await fixture(t); await mutate(f); await f.save();
  for (const action of ["admit-hosted", "replace"]) {
    await assert.rejects(executeStage(action, { ...f.context, drained: true }));
    assert.ok(f.calls.every(({ name, args }) => name !== "docker" || args[0] === "image" && args[1] === "inspect"));
    await assert.rejects(readFile(artifactPath(f.context)), { code: "ENOENT" });
  }
});

test("verify-only checks the complete catalog without Docker, preimages or an admission receipt", async t => {
  const f = await fixture(t); await rm(preimagePath(f.context));
  f.context.plan = catalog.images;
  assert.equal(await executeStage("verify-hosted", f.context), 0);
  assert.equal(f.calls.filter(({ name }) => name === "cosign").length, 1 + 2 * catalog.images.length);
  assert.ok(f.calls.every(({ name }) => name === "cosign"));
  await assert.rejects(readFile(artifactPath(f.context)), { code: "ENOENT" });
});

test("failed verify-only gate never reaches a caller's load/tag operations", async t => {
  for (const [reason, mutate] of Object.entries(refusals).filter(([reason]) => reason !== "loaded config mismatch")) {
    const f = await fixture(t); await mutate(f); await f.save();
    const before = structuredClone(f.details);
    const preload = async () => {
      await executeStage("verify-hosted", f.context);
      await f.context.command("docker", ["load", "--input", "candidate.tar"]);
      await f.context.command("docker", ["image", "tag", "candidate", "wasalx/portal:local"]);
    };
    await assert.rejects(preload(), undefined, reason);
    assert.ok(f.calls.every(({ name }) => name === "cosign"), reason);
    assert.deepEqual(f.details, before, reason);
  }
});

test("duplicate JSON catalog keys reject even when the duplicate values match", async t => {
  const f = await fixture(t), text = JSON.stringify(f.inventory);
  const row = JSON.stringify(f.inventory.images.zammad);
  await f.save(text.replace(`"zammad":${row}`, `"zammad":${row},"zammad":${row}`));
  await assert.rejects(executeStage("admit-hosted", f.context), /duplicate hosted JSON key/u);
  assert.deepEqual(f.calls, []);
});

test("hosted admission requires original rollback custody before preloading", async t => {
  const f = await fixture(t); await rm(preimagePath(f.context));
  await assert.rejects(executeStage("admit-hosted", f.context), { code: "ENOENT" });
  assert.deepEqual(f.calls, []);
});

test("hosted receipt rejects changed bindings and never accepts BUILT as admission", async t => {
  const f = await fixture(t); await executeStage("admit-hosted", f.context);
  const bytes = await readFile(artifactPath(f.context)), original = JSON.parse(bytes);
  for (const field of ["candidateSha", "candidateTree", "project", "catalogSha256", "hostedImagesSha256", "modelSha256", "trustedRootSha256"]) {
    const changed = { ...original, [field]: "changed" }; await writeFile(artifactPath(f.context), JSON.stringify(changed));
    await assert.rejects(readBoundArtifacts(f.context));
  }
  for (const mutate of [m => { m.images[0].state = "BUILT"; }, m => { m.preimage.transactionId = "changed"; }, m => { m.preimage.sha256 = "changed"; }]) {
    const changed = structuredClone(original); mutate(changed); await writeFile(artifactPath(f.context), JSON.stringify(changed));
    await assert.rejects(readBoundArtifacts(f.context));
  }
  await writeFile(artifactPath(f.context), bytes);
  await f.save(JSON.stringify(f.inventory) + " ");
  await assert.rejects(readBoundArtifacts(f.context), /binding changed/u);
});

test("classic config IDs are accepted but an unrelated Docker ID is refused", async t => {
  const f = await fixture(t);
  for (const image of f.context.plan) f.details[image.reference].Id = f.inventory.images[image.id].configDigest;
  assert.equal((await verifyHostedImages(f.context)).images.length, 21);
  f.details[f.context.plan.at(-1).reference].Id = `sha256:${"d".repeat(64)}`;
  await assert.rejects(verifyHostedImages(f.context), /loaded hosted image identity mismatch/u);
});

test("admitted hosted IDs reach replacement through the existing drained Compose path", async t => {
  const f = await fixture(t); await executeStage("admit-hosted", f.context);
  const command = f.context.command, replacements = [];
  f.context.command = async (name, args, ...rest) => {
    if (name === "docker" && args[0] === "compose" && args.includes("up")) { replacements.push(args); return 0; }
    return command(name, args, ...rest);
  };
  assert.equal(await executeStage("replace", { ...f.context, drained: true }), 0);
  assert.deepEqual(replacements, [[...f.context.composeArguments, "up", "--no-build", "--pull", "never", "--wait"]]);
});

test("local build retains its label checks and original build receipt", async t => {
  const f = await fixture(t);
  delete f.context.hostedImages; delete f.context.hostedImagesSha256; delete f.context.hostedTrustedRoot;
  f.context.buildContext = Buffer.from("synthetic canonical archive"); f.context.buildContextSha256 = sha256(f.context.buildContext);
  assert.equal(await executeStage("build", f.context), 0);
  const { manifest } = await readBoundArtifacts(f.context);
  assert.equal(manifest.kind, "compose-candidate-artifacts");
  assert.equal(manifest.buildContextAlgorithm, "sha256-git-archive-tar-v1");
  assert.ok(manifest.images.every(image => image.state === "BUILT"));
  assert.equal(f.calls.filter(({ name, args }) => name === "docker" && args[0] === "build").length, 21);
  assert.ok(f.calls.every(({ name }) => name === "docker"));
  f.details[f.context.plan[0].reference].Config.Labels["io.wasalx.build.context-sha256"] = "changed";
  await assert.rejects(executeStage("replace", f.context), /requires the build stage/u);
});
