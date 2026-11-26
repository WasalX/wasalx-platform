import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import cosignPin from "../scripts/release/cosign-pin.json" with { type: "json" };
import { assertLocalRegistry, hostedIssuer, localRegistryReference, verifyHostedImages } from "../scripts/release/installer-hosted-images.mjs";
import { artifactPath, preimagePath, preserveReplacement, readBoundArtifacts, sha256 } from "../scripts/release/installer-artifacts.mjs";
import { createCandidatePlan, executeStage, run } from "../scripts/release/installer-stages.mjs";
import { localRegistryOverlay } from "../scripts/release/installer-stack.mjs";

const catalog = JSON.parse(await readFile(new URL("../release/installer-images.json", import.meta.url)));
const candidateSha = "a".repeat(40), candidateTree = "b".repeat(40);
const source = "https://github.com/WasalX/wasalx-platform";
const devPublisher = `${source}/.github/workflows/branch-image.yml@refs/heads/dev`;
const mainPublisher = `${source}/.github/workflows/branch-image.yml@refs/heads/main`;

const localRegistry = "127.0.0.1:5007";
const dependency = `quay.io/example/dependency:1.0@sha256:${"d".repeat(64)}`;
const stagedDependency = `${localRegistry}/staged/${"d".repeat(64)}@sha256:${"d".repeat(64)}`;

test("local registry only accepts loopback and explicitly allowed endpoints", () => {
  assertLocalRegistry(localRegistry, {});
  const endpoint = "registry.example.invalid:5000";
  const environment = { WASALX_LOCAL_REGISTRY_ALLOWLIST: `other.example.invalid:5000, ${endpoint}` };
  assertLocalRegistry(endpoint, environment);
  assert.throws(() => assertLocalRegistry(endpoint, {}), /must be loopback or listed/u);
  assert.throws(() => assertLocalRegistry("registry.example.invalid:5001", environment), /must be loopback or listed/u);
});

test("local registry rewrites only active dependencies and binds the persisted overlay", async t => {
  const { context } = await fixture(t);
  const { services } = context.model;
  services.dependency = { image: dependency, profiles: ["full"] };
  services.inactive = { image: "example/inactive:latest", profiles: ["inactive"] };
  const inputs = { registry: localRegistry, envFile: join(context.repository, "fixture.env"), project: "fixture",
    profiles: ["full"], render: () => context.model };
  const path = await localRegistryOverlay(inputs);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { services: { dependency: { image: stagedDependency } } });
  assert.equal(await localRegistryOverlay(inputs), path);
  await assert.rejects(localRegistryOverlay({ ...inputs, registry: "localhost:5008" }), /overlay differs/u);
  await assert.rejects(localRegistryOverlay({ ...inputs, registry: "https://example.invalid:5007" }), /requires a host and port/u);
  services.dependency.image = "example/dependency:latest";
  await assert.rejects(localRegistryOverlay(inputs), /digest-pinned image/u);
});

test("local registry preload pulls only the staged digests and admission rejects an alias mismatch", async t => {
  const { context, inventory, details } = await fixture(t);
  context.localRegistry = localRegistry;
  context.model.services.dependency = { image: dependency };
  const staged = Object.values(inventory.images).map(row => localRegistryReference(localRegistry, row.pullReference));
  const pulls = [];
  const run = context.command;
  context.command = async (command, args, ...rest) => {
    if (command === "docker" && args[0] === "pull") {
      const reference = args.at(-1);
      assert.ok([...staged, stagedDependency].includes(reference));
      assert.deepEqual(args.slice(args.indexOf("--platform"), args.indexOf("--platform") + 2), ["--platform", "linux/amd64"]);
      pulls.push(reference);
      details[reference] = { Id: reference.split("@")[1], RepoDigests: [reference] };
      return 0;
    }
    if (command === "docker" && args[0] === "image" && args[1] === "tag") {
      assert.equal(details[args[2]].Id, details[args[3]].Id);
      return "";
    }
    return run(command, args, ...rest);
  };
  await assert.rejects(executeStage("preload-hosted", context), /every dependency to resolve to the staging registry/u);
  assert.deepEqual(pulls, []);
  context.model.services.dependency.image = stagedDependency;
  await executeStage("preload-hosted", context);
  assert.deepEqual(pulls, [...staged, stagedDependency]);
  assert.equal((await verifyHostedImages(context)).images.length, context.plan.length);

  const reference = staged[0];
  const original = details[reference];
  details[reference] = { ...original, RepoDigests: [] };
  await assert.rejects(verifyHostedImages(context), /loaded local registry digest mismatch/u);
  details[reference] = { ...original, Id: stagedDependency.split("@")[1] };
  await assert.rejects(verifyHostedImages(context), /alias does not identify its staged digest/u);
});

test("fresh held smoke keeps the registry and simulator flags, and replace refuses a changed staged image ID", async t => {
  const { context, inventory, details, calls } = await fixture(t);
  context.localRegistry = localRegistry;
  for (const { id, reference } of context.plan) {
    const staged = localRegistryReference(localRegistry, inventory.images[id].pullReference);
    details[staged] = { Id: details[reference].Id, RepoDigests: [staged] };
  }
  await executeStage("admit-hosted", context);
  const command = context.command;
  const smokes = [];
  context.command = (name, args, ...rest) => {
    if (name === process.execPath) { smokes.push(args); return 0; }
    return command(name, args, ...rest);
  };
  const held = { ...context, devFreshHeld: true, devSimulator: true };
  assert.equal(await executeStage("smoke", held), 0);
  assert.equal(smokes.length, 1);
  const registryFlag = smokes[0].indexOf("--local-registry");
  assert.ok(registryFlag > 0);
  assert.equal(smokes[0][registryFlag + 1], localRegistry);
  assert.ok(smokes[0].includes("--dev-fresh-held") && smokes[0].includes("--dev-simulator"));

  const { id, reference } = context.plan.at(-1);
  const staged = localRegistryReference(localRegistry, inventory.images[id].pullReference);
  details[staged].Id = inventory.images[id].configDigest;
  assert.notEqual(details[staged].Id, details[reference].Id);
  calls.length = 0;
  await assert.rejects(executeStage("replace", { ...held, drained: true }), /staged hosted image changed/u);
  assert.ok(calls.every(({ name, args }) => name === "docker" && (args[0] === "info" || args[0] === "image" && args[1] === "inspect")));
  await assert.rejects(readFile(join(context.directory, `replacement-started-${context.project}.json`)), { code: "ENOENT" });
});

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
      digest, configDigest, pullReference: `ghcr.io/wasalx/${image.id}@${digest}`, workflow: mainPublisher,
      inspection: { configDigest }, status: "published", verified: true };
    inventory.images[image.id] = row;
    const path = join(root, image.id, "manifest.json");
    await mkdir(join(root, image.id)); await writeFile(path, raw);
    manifests[image.id] = { path, raw };
    details[image.reference] = { Id: digest, Config: config.config };
    signatures[image.id] = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: { certificate: { Subject: mainPublisher, Issuer: hostedIssuer } },
      dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify({ predicateType: "https://sigstore.dev/cosign/sign/v1", subject: [{ digest: { sha256: digest.slice(7) } }] })).toString("base64") } };
    statements[image.id] = { predicateType: "https://slsa.dev/provenance/v0.2", subject: [{ name: `ghcr.io/wasalx/${image.id}`, digest: { sha256: digest.slice(7) } }],
      predicate: { builder: { id: mainPublisher }, buildType: `${source}/image-build/v1`,
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
      if (args[0] === "version") return JSON.stringify({ gitVersion: cosignPin.version });
      assert.equal(args[0], "verify-blob-attestation");
      assert.ok(args.includes("--offline") && args.includes("--trusted-root"));
      const identity = args[args.indexOf("--certificate-identity") + 1];
      assert.equal(identity, mainPublisher);
      assert.equal(args[args.indexOf("--certificate-oidc-issuer") + 1], hostedIssuer);
      assert.ok(!args.some(arg => arg.includes("regexp") || arg.includes("insecure")));
      const bundle = JSON.parse(await readFile(args[args.indexOf("--bundle") + 1]));
      assert.equal(bundle.verificationMaterial.certificate.Subject, identity, "cosign certificate identity rejected");
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
  assert.equal(manifest.publisher, mainPublisher);
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

test("a publication from any other ref is rejected before cosign", async t => {
  for (const ref of ["refs/heads/feature", "refs/heads/main-extra", "refs/tags/dev", "refs/pull/1/merge"]) {
    const f = await fixture(t);
    for (const row of Object.values(f.inventory.images)) row.workflow = mainPublisher.replace("refs/heads/main", ref);
    await f.save();
    await assert.rejects(verifyHostedImages(f.context), /hosted publisher identity mismatch/u);
    assert.deepEqual(f.calls, []);
  }
});

test("nightly verifies main signatures before pulling any digest for the PR installer", async t => {
  const f = await fixture(t);
  const context = { ...f.context, candidateSha: "c".repeat(40), candidateTree: "d".repeat(40),
    imageSource: { commit: candidateSha, tree: candidateTree } };
  const calls = [];
  context.command = (name, args, ...rest) => {
    calls.push({ name, args });
    if (name === "docker") return args[0] === "pull" ? 0 : "";
    return f.context.command(name, args, ...rest);
  };

  assert.equal(await executeStage("preload-hosted", context), 0);
  assert.equal(calls.findIndex(({ name }) => name === "docker"), 1 + 2 * catalog.images.length);
  assert.deepEqual(calls.filter(({ args }) => args[0] === "pull").map(({ args }) => args.at(-1)),
    context.plan.map(({ id }) => f.inventory.images[id].pullReference));

  calls.length = 0;
  f.signatures.zammad.verificationMaterial.certificate.Subject = devPublisher;
  await f.save();
  await assert.rejects(executeStage("preload-hosted", { ...context, hostedImagesSha256: f.context.hostedImagesSha256 }),
    /cosign certificate identity rejected/u);
  assert(calls.every(({ name }) => name !== "docker"));
});

test("a dev signature is rejected even when the inventory claims main", async t => {
  const f = await fixture(t);
  f.signatures.zammad.verificationMaterial.certificate.Subject = devPublisher;
  await f.save();
  await assert.rejects(executeStage("verify-hosted", f.context), /cosign certificate identity rejected/u);
  assert.ok(f.calls.every(({ name }) => name === "cosign"));
});

const refusals = {
  "dev inventory publisher": f => { f.inventory.images.zammad.workflow = devPublisher; },
  "dev provenance builder": f => { f.statements.zammad.predicate.builder.id = devPublisher; },
  "missing identity": f => { delete f.signatures.zammad.verificationMaterial.certificate.Subject; },
  "wrong issuer": f => { f.signatures.zammad.verificationMaterial.certificate.Issuer = "https://example.invalid"; },
  "missing issuer": f => { delete f.signatures.zammad.verificationMaterial.certificate.Issuer; },
  "tag only": f => { f.inventory.images.zammad.pullReference = "ghcr.io/wasalx/zammad:dev"; },
  "tag plus digest": f => { f.inventory.images.zammad.pullReference = f.inventory.images.zammad.pullReference.replace("@", ":dev@"); },
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

test("hosted installer CLI refuses an unknown install profile before host checks", () => {
  const script = fileURLToPath(new URL("../scripts/release/installer-stages.mjs", import.meta.url));
  const path = fileURLToPath(new URL("./missing-installer-env", import.meta.url));
  const env = { ...process.env, WASALX_INSTALL_EXPECTED_HOSTNAME: "" };
  const result = spawnSync(process.execPath, ["--", script, "verify-hosted",
    "--env-file", path, "--project-name", "fixture", "--hosted-images", path,
    "--hosted-images-sha256", "a".repeat(64), "--hosted-trusted-root", path, "--install-profile", "unknown"],
  { env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "remote full qualification failed\nremote full qualification reason: Error\n");
});

test("local registry CLI rejects unsafe stages before inspecting the host", () => {
  const script = fileURLToPath(new URL("../scripts/release/installer-stages.mjs", import.meta.url));
  const path = fileURLToPath(new URL("./missing-installer-env", import.meta.url));
  const env = { ...process.env, DEPLOY_ENVIRONMENT: "dev", WASALX_ENVIRONMENT: "dev",
    WASALX_INSTALL_EXPECTED_HOSTNAME: "", WASALX_LOCAL_REGISTRY_ALLOWLIST: "" };
  const hosted = ["--hosted-images", path, "--hosted-images-sha256", "a".repeat(64), "--hosted-trusted-root", path];
  const local = ["--local-registry", localRegistry];
  for (const [action, flags, reason] of [
    ["replace", ["--dev-fresh-held", "--dev-simulator", ...local], /requires a hosted install stage or preflight/u],
    ["verify-hosted", [...hosted, ...local], /requires a hosted install stage or preflight/u],
    ["preload-hosted", hosted, /preload requires hosted images and the rehearsal or local registry/u],
    ["preflight", ["--local-registry", "registry.example.invalid:5000"], /must be loopback or listed/u],
  ]) {
    const result = spawnSync(process.execPath, ["--", script, action, "--env-file", path,
      "--project-name", "wasalx-dev-fixture", ...flags],
    { env, encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, reason);
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

test("verify-hosted reports the DEV webhook preflight skip without running Docker", async t => {
  const { context } = await fixture(t);
  const script = fileURLToPath(new URL("../scripts/release/installer-stages.mjs", import.meta.url));
  const preload = `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const outputs = new Map(Object.entries(${JSON.stringify({
      "git rev-parse HEAD": candidateSha,
      "git rev-parse HEAD^{tree}": candidateTree,
      "git status --porcelain=v1 --untracked-files=all": "",
      "cosign version --json": JSON.stringify({ gitVersion: cosignPin.version }),
    })}));
    childProcess.spawnSync = (command, args) => {
      if (command === "cosign" && args[0] === "verify-blob-attestation") return { status: 0, stdout: "" };
      const output = outputs.get([command, ...args].join(" "));
      assert.notEqual(output, undefined, "unexpected installer subprocess");
      return { status: 0, stdout: output };
    };
    childProcess.spawn = () => assert.fail("unexpected installer subprocess");
    syncBuiltinESMExports();
  `;
  const env = { ...process.env, WASALX_INSTALL_EXPECTED_HOSTNAME: hostname(), DEPLOY_ENVIRONMENT: "", WASALX_ENVIRONMENT: "" };
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    "--", script, "verify-hosted", "--env-file", join(context.repository, "install.env"), "--project-name", "wasalx-live",
    "--hosted-images", context.hostedImages, "--hosted-images-sha256", context.hostedImagesSha256,
    "--hosted-trusted-root", context.hostedTrustedRoot, "--dev-skip-public-webhook-preflight"],
  { env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hosted inputs verified; no images loaded or tagged\n");
  assert.equal(result.stderr, "public webhook preflight skipped by DEV option\n");
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
  await writeFile(artifactPath(f.context), JSON.stringify({ ...original, publisher: devPublisher }));
  await assert.rejects(readBoundArtifacts(f.context), { code: "ERR_ASSERTION" });
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

test("admitted hosted IDs reach replacement, smoke and held release without repeating verification", async t => {
  const f = await fixture(t); await executeStage("admit-hosted", f.context);
  const command = f.context.command, replacements = [], smokes = [];
  f.context.command = async (name, args, ...rest) => {
    assert.notEqual(name, "cosign");
    assert.notEqual(name, "python3", "loaded-config invokes docker image save");
    assert.ok(name !== "docker" || !args.includes("save"));
    if (name === "docker" && args[0] === "compose" && args.includes("up")) { replacements.push(args); return 0; }
    if (name === process.execPath) { smokes.push(args); return 0; }
    return command(name, args, ...rest);
  };
  assert.equal(await executeStage("replace", { ...f.context, drained: true }), 0);
  assert.deepEqual(replacements, [[...f.context.composeArguments, "up", "--no-build", "--pull", "never", "--wait"]]);
  const envFile = join(f.context.privateDirectory, "full.env");
  const devPreimagesFile = join(f.context.privateDirectory, "dev-preimages.json");
  const devPreimagesSha256 = "c".repeat(64);
  assert.equal(await executeStage("smoke", { ...f.context, envFile, devPreimagesFile, devPreimagesSha256 }), 0);
  assert.equal(smokes.length, 1);
  assert.deepEqual(smokes[0].slice(1), ["fixture", "--full", "--env-file", envFile,
    "--compose-file", "compose.yaml", "--compose-file", "compose.full.yaml", "--profile", "full", "--profile", "runtime-workers",
    "--dev-preimages", devPreimagesFile, "--dev-preimages-sha256", devPreimagesSha256,
    ...f.context.plan.flatMap(({ id, reference }) => ["--candidate-image", `${id}=${reference}`])]);
  await assert.rejects(executeStage("release-held", f.context), /held release requires bound DEV preimages/u);
});

test("hosted replacement refuses a missing receipt, a changed image ID and a different inventory", async t => {
  const f = await fixture(t);
  const context = { ...f.context, drained: true };
  await assert.rejects(executeStage("replace", context), { code: "ENOENT" });
  assert.deepEqual(f.calls, []);
  await executeStage("admit-hosted", f.context);
  f.calls.length = 0;
  const image = context.plan.at(-1), details = f.details[image.reference], admittedId = details.Id;
  details.Id = f.inventory.images[image.id].configDigest;
  assert.notEqual(details.Id, admittedId);
  for (const action of ["replace", "smoke", "release-held"]) {
    await assert.rejects(executeStage(action, context), /admitted hosted image changed/u);
  }
  assert.ok(f.calls.every(({ name, args }) => name === "docker" && (args[0] === "info" || args[0] === "image" && args[1] === "inspect")));
  details.Id = admittedId;
  f.calls.length = 0;
  await f.save(JSON.stringify(f.inventory) + "\n");
  assert.notEqual(f.context.hostedImagesSha256, context.hostedImagesSha256);
  await assert.rejects(executeStage("replace", { ...f.context, drained: true }), /hostedImagesSha256 binding changed/u);
  assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(join(context.directory, `replacement-started-${context.project}.json`)), { code: "ENOENT" });
});

async function localBuildFixture(t) {
  const f = await fixture(t);
  delete f.context.hostedImages; delete f.context.hostedImagesSha256; delete f.context.hostedTrustedRoot;
  f.context.buildContext = Buffer.from("synthetic canonical archive"); f.context.buildContextSha256 = sha256(f.context.buildContext);
  return f;
}

function mockImageInspect(t, f, response) {
  t.mock.method(childProcess, "spawnSync", (name, args) => {
    assert.equal(name, "docker");
    assert.deepEqual(args.slice(0, 2), ["image", "inspect"]);
    return response(args[2]) ?? { status: 0, stdout: JSON.stringify([f.details[args[2]]]) };
  });
  syncBuiltinESMExports();
  const command = f.context.command;
  f.context.command = (name, args, ...options) => args[0] === "image" && args[1] === "inspect"
    ? run(name, args, ...options) : command(name, args, ...options);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("local build prepares missing images and retains its label checks and build receipt", async t => {
  const f = await localBuildFixture(t);
  const [{ reference }] = f.context.plan;
  const digest = `sha256:${"d".repeat(64)}`;
  const pinned = `docker.io/library/postgres:17@${digest}`;
  f.context.model.services.dependency = { image: pinned };
  const missing = ref => ({ status: 1, stdout: "[]\n", stderr: `Error response from daemon: No such image: ${ref}\n` });
  let candidateInspections = 0;
  mockImageInspect(t, f, ref => {
    if (ref === reference && ++candidateInspections === 1) return missing(reference);
    if (ref === pinned && !f.details[pinned]) return missing(`postgres:17@${digest}`);
  });
  const command = f.context.command, pulls = [];
  f.context.command = (name, args, ...options) => {
    if (name !== "docker" || args[0] !== "pull") return command(name, args, ...options);
    pulls.push(args);
    f.details[pinned] = { Id: digest };
    return "";
  };
  assert.equal(await executeStage("build", f.context), 0);
  const { manifest } = await readBoundArtifacts(f.context);
  assert.equal(manifest.kind, "compose-candidate-artifacts");
  assert.equal(manifest.buildContextAlgorithm, "sha256-git-archive-tar-v1");
  assert.ok(manifest.images.every(image => image.state === "BUILT"));
  assert.equal(f.calls.filter(({ name, args }) => name === "docker" && args[0] === "build").length, 21);
  assert.deepEqual(pulls, [["pull", "--quiet", pinned]]);
  assert.ok(f.calls.every(({ name }) => name === "docker"));
  f.details[f.context.plan[0].reference].Config.Labels["io.wasalx.build.context-sha256"] = "changed";
  await assert.rejects(executeStage("replace", f.context), /requires the build stage/u);
});

test("local build refuses image inspection failures before building or pulling", async t => {
  const f = await localBuildFixture(t);
  const [{ reference }] = f.context.plan;
  const inspected = Config => JSON.stringify([{ Id: f.details[reference].Id, Config }]);
  const cases = [
    ["subprocess error with valid stdout", { status: 0, error: new Error("ENOBUFS"), stdout: inspected(null) }, /subprocess failed/u],
    ["malformed config", { status: 0, stdout: inspected([]) }, /invalid configuration/u],
    ["malformed labels", { status: 0, stdout: inspected({ Labels: [] }) }, /invalid labels/u],
    ["malformed label value", { status: 0, stdout: inspected({ Labels: { "fixture.label": 1 } }) }, /invalid labels/u],
    ["unavailable daemon", { status: 1, stdout: "[]\n", stderr: "Cannot connect to the Docker daemon\n" }, /Cannot connect/u],
    ["permission denied", { status: 1, stdout: "[]\n", stderr: "permission denied\n" }, /permission denied/u],
    ["mixed diagnostics", { status: 1, stdout: "[]\n", stderr: `permission denied\nError response from daemon: No such image: ${reference}\n` }, /permission denied/u],
    ["missing different image", { status: 1, stdout: "[]\n", stderr: "Error response from daemon: No such image: other:latest\n" }, /No such image/u],
    ["malformed JSON", { status: 0, stdout: "[invalid" }, /returned malformed JSON/u],
    ["empty success", { status: 0, stdout: "[]" }, /one valid image ID/u],
    ["invalid image ID", { status: 0, stdout: '[{"Id":"invalid"}]' }, /one valid image ID/u],
  ];
  const command = f.context.command;
  for (const [scenario, response, reason] of cases) await t.test(scenario, async subtest => {
    f.context.command = command;
    f.calls.length = 0;
    mockImageInspect(subtest, f, ref => {
      assert.equal(ref, reference);
      return response;
    });
    await assert.rejects(executeStage("build", f.context), reason);
    assert.ok(f.calls.every(({ args }) => args[0] !== "build" && args[0] !== "pull"));
    const { manifest } = await readBoundArtifacts(f.context, { allowPartial: true });
    assert.equal(manifest.state, "FAILED");
    assert.equal(manifest.images[0].state, "FAILED");
  });
});

test("local build reuses canonical images with matching labels", async t => {
  const f = await localBuildFixture(t);
  for (const image of f.context.plan) {
    Object.assign(f.details[image.reference].Config.Labels, {
      "io.wasalx.build.dockerfile": image.dockerfile,
      "io.wasalx.build.context-sha256": f.context.buildContextSha256,
    });
  }
  mockImageInspect(t, f, () => undefined);
  assert.equal(await executeStage("build", f.context), 0);
  const { manifest } = await readBoundArtifacts(f.context);
  assert.ok(manifest.images.every(image => image.state === "REUSED"));
  assert.ok(f.calls.every(({ args }) => args[0] !== "build"));
});

test("local build refuses a pinned dependency inspection failure without pulling", async t => {
  const f = await localBuildFixture(t);
  f.context.model.services.dependency = { image: dependency };
  mockImageInspect(t, f, ref => {
    if (ref === dependency) return { status: 1, stdout: "[]\n", stderr: "permission denied\n" };
  });
  await assert.rejects(executeStage("build", f.context), /permission denied/u);
  assert.ok(f.calls.every(({ args }) => args[0] !== "pull"));
});
