import assert from "node:assert/strict";
import { containerName } from "../../scripts/release/ci-browser-runtime.mjs";

// Share only the job container's offline loopback; never the shared host network.
export function fixtureNetwork(env = process.env) {
  const name = env.WASALX_CI_FIXTURE_NETWORK;
  if (name === undefined) return null;
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.WASALX_CI_BROWSER_INSIDE, "1");
  assert.match(name, /^wasalx-ci-browser-[1-9][0-9]*-[1-9][0-9]*-[A-Za-z0-9_.-]+$/u);
  assert.equal(name, containerName(env), "fixtures must belong to this exact CI job attempt");
  return name;
}

export function fixtureNetworkArgs(port, hostPort, env = process.env) {
  const name = fixtureNetwork(env);
  return name ? ["--network", `container:${name}`, "--pull", "never", "--label", `io.wasalx.ci-browser-owner=${name}`] : ["-p", `127.0.0.1:${hostPort}:${port}`];
}
