import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectStack, devHeldServices, devPreservedServices, devContainerPreimage, devValueDigest } from "../scripts/release/installer-stack.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sha = "a".repeat(40);
const tree = "b".repeat(40);

function stackFixture() {
  const candidateReference = "wasalx/portal:test";
  const thirdPartyDigest = `sha256:${"2".repeat(64)}`;
  const thirdPartyReference = `postgres:17@${thirdPartyDigest}`;
  const candidateDetails = { Id: `sha256:${"1".repeat(64)}`, RepoDigests: [], Config: {
    Labels: { "org.opencontainers.image.revision": sha, "io.wasalx.source.tree": tree },
    Healthcheck: { Test: ["CMD", "true"] },
  } };
  const thirdPartyDetails = { Id: `sha256:${"3".repeat(64)}`, RepoDigests: [`postgres@${thirdPartyDigest}`], Config: {
    Labels: {}, Healthcheck: { Test: ["CMD", "true"] },
  } };
  const compose = { services: {
    app: { image: candidateReference, build: { context: repositoryRoot, dockerfile: "Dockerfile.portal" }, restart: "unless-stopped", healthcheck: { test: ["CMD", "true"] }, depends_on: { migrate: { condition: "service_completed_successfully" } } },
    migrate: { image: candidateReference, build: { context: repositoryRoot, dockerfile: "Dockerfile.portal" }, restart: "no" },
    postgres: { image: thirdPartyReference, restart: "unless-stopped", healthcheck: { test: ["CMD", "true"] } },
  } };
  const running = (service, reference, image, health = "healthy") => ({
    service, Config: { Image: reference, Healthcheck: image.Config.Healthcheck }, Image: image.Id, RestartCount: 0,
    HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    State: { Status: "running", Running: true, Paused: false, ExitCode: 0, Health: { Status: health }, StartedAt: "2026-08-24T09:00:00.000Z" },
  });
  const containers = [
    running("app", candidateReference, candidateDetails),
    { service: "migrate", Config: { Image: candidateReference, Healthcheck: candidateDetails.Config.Healthcheck },
      HostConfig: { RestartPolicy: { Name: "no" } }, Image: candidateDetails.Id, RestartCount: 0,
      State: { Status: "exited", Running: false, Paused: false, ExitCode: 0, StartedAt: "2026-08-24T09:00:00.000Z" } },
    running("postgres", thirdPartyReference, thirdPartyDetails),
  ];
  return {
    compose, containers,
    imageInspections: [{ reference: candidateReference, details: candidateDetails }, { reference: thirdPartyReference, details: thirdPartyDetails }],
    catalog: { smokeImageIds: ["portal"], images: [{ id: "portal", dockerfile: "Dockerfile.portal" }, { id: "zammad", dockerfile: "infra/docker/Dockerfile.zammad" }] },
    candidateImages: [{ id: "portal", reference: candidateReference }], candidateSha: sha, candidateTree: tree, repositoryRoot,
  };
}

function devHeldStackFixture() {
  const fixture = stackFixture();
  const oneShots = devPreservedServices.filter((name) => !devHeldServices.includes(name) && name !== "zammad-backup");
  const names = [...new Set([...devHeldServices, ...devPreservedServices, "control-api"])];
  for (const name of names) {
    const oneShot = oneShots.includes(name);
    fixture.compose.services[name] = structuredClone(fixture.compose.services[oneShot ? "migrate" : "app"]);
    const row = structuredClone(fixture.containers[oneShot ? 1 : 0]); row.service = name;
    row.Id = String(names.indexOf(name)+1).padStart(64,"0"); row.HostConfig.ReadonlyRootfs = true;
    row.State.Pid = name === "zammad-backup" ? 100 : 0; row.State.Dead = false;
    if (devHeldServices.includes(name) || oneShot || name === "control-api") {
      row.State.Running = false; row.State.Status = "exited";
    }
    fixture.containers.push(row);
    if (oneShot) fixture.compose.services.app.depends_on[name] = { condition: "service_completed_successfully" };
  }
  for (const [index,row] of fixture.containers.entries()) row.Id ??= String(index+100).padStart(64,"0");
  const oldImageId=`sha256:${"4".repeat(64)}`;
  const oldDetails=structuredClone(fixture.imageInspections[0].details);oldDetails.Id=oldImageId;
  oldDetails.Config.Labels["org.opencontainers.image.revision"]="c".repeat(40);
  oldDetails.Config.Labels["io.wasalx.source.tree"]="d".repeat(40);
  fixture.imageInspections.push({reference:oldImageId,details:oldDetails});
  for(const row of fixture.containers.filter(row=>devPreservedServices.includes(row.service))){row.Image=oldImageId;row.Config.Image="wasalx/zammad:0.5.55";}
  fixture.activeServices = Object.keys(fixture.compose.services).sort();
  fixture.devPreimages = {
    schemaVersion:1, kind:"dev-held-install-preimages", candidateSha:sha, candidateTree:tree,
    project:"wasalx-live", machineIdSha256:"f".repeat(64), heldServices:[...devHeldServices].sort(),
    preservedServices:[...devPreservedServices].sort(),
    services:fixture.containers.map(devContainerPreimage).sort((a,b)=>a.service.localeCompare(b.service)),
    nativeSync:{tableExists:false,pending:0,unavailableCount:0,unavailableSha256:devValueDigest([])},
  };
  fixture.containers.find(row=>row.service==="control-api").State = structuredClone(fixture.containers[0].State);
  for (const name of ["connector-worker","identity-policy-activator","invitation-mailer"]) fixture.containers.find(row=>row.service===name).State.Status="created";
  return fixture;
}

test("DEV stack smoke preserves a failed held prerequisite and still refuses a non-held success-dependent", () => {
  const fixture = devHeldStackFixture();
  for (const service of Object.values(fixture.compose.services)) delete service.depends_on?.["public-webhook-preflight"];
  fixture.compose.services["waha-gows"].depends_on["public-webhook-preflight"] = { condition: "service_completed_successfully" };
  fixture.devPreimages.heldPrerequisites = { "public-webhook-preflight": ["waha-gows"] };
  fixture.devPreimages.heldServices.push("public-webhook-preflight"); fixture.devPreimages.heldServices.sort();
  fixture.containers.find(row => row.service === "public-webhook-preflight").State.ExitCode = 1;
  fixture.devPreimages.services.find(row => row.service === "public-webhook-preflight").exitCode = 1;
  const projection = projectStack(fixture);
  assert.deepEqual(projection.heldPrerequisites, fixture.devPreimages.heldPrerequisites);
  assert.equal(projection.services.find(row => row.service === "public-webhook-preflight").exitCode, 1);
  fixture.compose.services.app.depends_on["public-webhook-preflight"] = { condition: "service_completed_successfully" };
  assert.throws(() => projectStack(fixture), /held prerequisites changed/);
});
