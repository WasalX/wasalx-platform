import assert from "node:assert/strict";
import test from "node:test";
import { assertRetainedPreimage } from "../scripts/release/installer-artifacts.mjs";

const id = "c".repeat(64);
const imageId = `sha256:${"d".repeat(64)}`;

const retainedMounts = [
  { Destination: "/b", Source: "/srv/b", Type: "bind", RW: true },
  { Destination: "/c", Source: "/srv/c", Type: "bind", RW: false },
  { Destination: "/a", Source: "/srv/a", Type: "bind", RW: true },
];

function compareRetainedMounts(current) {
  const original = { Id: id, Image: imageId, Name: "/portal", HostConfig: {}, Mounts: retainedMounts,
    Config: { Labels: { "com.docker.compose.project": "fixture", "com.docker.compose.service": "portal" } } };
  const context = { project: "fixture", environment: {}, command: async (name, args) => {
    assert.equal(name, "docker");
    if (args[0] === "ps") return id;
    assert.deepEqual(args, ["inspect", id]);
    return JSON.stringify([{ ...original, Mounts: current }]);
  } };
  return assertRetainedPreimage(context, { containers: [{ id, image: imageId, inspect: original, networks: [],
    compose: { files: [], environmentFiles: [] } }] });
}

test("retained preimage accepts the same mounts in different orders", async () => {
  await assert.doesNotReject(compareRetainedMounts([retainedMounts[1], retainedMounts[2], retainedMounts[0]]));
});

test("retained preimage rejects a changed mount value", async () => {
  await assert.rejects(compareRetainedMounts([{ ...retainedMounts[0], RW: false }, ...retainedMounts.slice(1)]), /Mounts preimage changed/u);
});

test("retained preimage rejects an added or removed mount", async () => {
  for (const current of [
    [...retainedMounts, { Destination: "/d", Source: "/srv/d", Type: "bind", RW: true }],
    retainedMounts.slice(1),
  ]) await assert.rejects(compareRetainedMounts(current), /Mounts preimage changed/u);
});
