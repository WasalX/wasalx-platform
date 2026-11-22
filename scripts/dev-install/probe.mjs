#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composePreimage, composeProfiles, dockerIdentity, inspectOwned } from "../release/installer-artifacts.mjs";
import { readDevNativeSync } from "../release/installer-stages.mjs";
import { activeServiceNames, devColdResidents, devContainerPreimage, devHeldPrerequisites, devHeldServices,
  devPreservedServices, oneShotServiceNames } from "../release/installer-stack.mjs";

const serviceLabel = "com.docker.compose.service";
const configHashLabel = "com.docker.compose.config-hash";
const servicePattern = /^(?!.*[a-f0-9]{24})[a-z0-9][a-z0-9_-]{0,62}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const fieldPattern = /^(?:compose\.(?:config-hash|version)|env_file|ipc|models|network_mode|pid|use_api_socket|volumes_from(?:\.\d{1,3})?)$/u;
const knownMessages = new Set([
  "actual ordered Compose chain unavailable", "Compose preimage path must be absolute", "Compose input changed during capture",
  "deployed Compose inputs resolve inside candidate repository", "deployed Compose working directory resolves inside candidate repository",
  "Docker host identity unavailable", "incomplete container census", "container ownership changed", "ambiguous service preimage",
  "invalid Compose service hash", "original rendered service unavailable", "private Compose hash inputs require root",
  "private hash inputs must be outside candidate and evidence trees",
]);

class ProbeError extends Error {}

export function sanitizeProbeError(error, { service, field } = {}) {
  const name = ["AssertionError", "SyntaxError", "TypeError", "RangeError"].includes(error?.name) ? error.name : "Error";
  const code = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS"].includes(error?.code) ? ` (${error.code})` : "";
  const message = error instanceof ProbeError || knownMessages.has(error?.message) ? error.message
    : name === "SyntaxError" ? "invalid native JSON" : "native read failed";
  const frames = [...String(error?.stack ?? "").matchAll(/^\s+at [^\r\n]*[\\/]scripts[\\/](?:release|dev-install)[\\/](probe|installer-artifacts|installer-stages|installer-stack)\.mjs:(\d{1,6}):\d+\)?$/gmu)]
    .slice(0, 3).map(([, file, line]) => `${file}.mjs:${line}`);
  const fields = service && Array.isArray(error?.rollbackFields) ? error.rollbackFields
    .filter(value => typeof value === "string")
    .map(value => value.startsWith(`${service}.`) ? value.slice(service.length + 1) : value)
    .filter(value => fieldPattern.test(value)).slice(0, 4) : [];
  const target = servicePattern.test(service ?? "") ? ` service=${service}` : "";
  const censusField = /^(?:inventory|cold-mode|RestartCount|State\.(?:Running|Status|Pid|ExitCode|Paused|Dead|Restarting|Health\.Status))$/u.test(field ?? "") ? ` field=${field}` : "";
  return `probe-scan error=${name} message=${message}${code}${target}${censusField}${fields.length ? ` fields=${fields.join(",")}` : ""}${frames.length ? ` at=${frames.join(",")}` : ""}`;
}

export function censusFailure(model, rows, heldServices, serviceCount) {
  const active = activeServiceNames(model, composeProfiles);
  const held = new Set(heldServices ?? [...devHeldServices, ...Object.keys(devHeldPrerequisites(model, active))]);
  const oneShots = new Set(oneShotServiceNames(model, active));
  const names = rows.map(row => row.Config?.Labels?.[serviceLabel]).sort();
  if (active.length !== serviceCount || !active.every(name => servicePattern.test(name)) || !isDeepStrictEqual(names, active)) return { field: "inventory" };
  for (const service of [...held, ...devPreservedServices]) {
    if (!active.includes(service)) return { field: "inventory" };
  }
  const preservedOneShots = devPreservedServices.filter(name => !devHeldServices.includes(name) && name !== "zammad-backup");
  if (preservedOneShots.some(name => !oneShots.has(name)) || oneShots.has("zammad-backup")) return { field: "inventory" };
  for (const row of rows) {
    const service = row.Config.Labels[serviceLabel];
    const state = row.State ?? {};
    const stopped = held.has(service);
    const oneShot = oneShots.has(service);
    if (!stopped && !oneShot && !state.Running && service !== "control-api" && !devColdResidents.includes(service)) {
      return { service, field: "cold-mode" };
    }
    if (!Number.isSafeInteger(row.RestartCount) || (stopped ? row.RestartCount < 0 : row.RestartCount !== 0)) return { service, field: "RestartCount" };
    if (state.Running !== !(stopped || oneShot)) return { service, field: "State.Running" };
    const status = stopped ? ["created", "exited"] : [oneShot ? "exited" : "running"];
    if (!status.includes(state.Status)) return { service, field: "State.Status" };
    if ((stopped || oneShot) && state.Pid !== 0) return { service, field: "State.Pid" };
    if (!stopped && oneShot && state.ExitCode !== 0) return { service, field: "State.ExitCode" };
    for (const field of ["Paused", "Dead", "Restarting"]) {
      if ((field === "Restarting" ? state[field] ?? false : state[field]) !== false) return { service, field: `State.${field}` };
    }
    const check = row.Config.Healthcheck?.Test;
    const enabled = Array.isArray(check) && check.length && check[0] !== "NONE";
    const configured = model.services[service].healthcheck;
    if (!stopped && !oneShot && ((configured && configured.disable !== true && !enabled) || (enabled && state.Health?.Status !== "healthy"))) {
      return { service, field: "State.Health.Status" };
    }
  }
  return null;
}

const words = output => output.split(/\s+/u).filter(Boolean);
const unique = values => [...new Set(values)].sort();

function projectResources(read, project, rows) {
  const label = `label=com.docker.compose.project=${project}`;
  const networks = unique([...words(read("network", "ls", "--filter", label, "--no-trunc", "--quiet")),
    ...rows.flatMap(row => Object.entries(row.NetworkSettings?.Networks ?? {}).map(([name, network]) => network.NetworkID || name))]);
  const volumes = unique([...words(read("volume", "ls", "--filter", label, "--quiet")),
    ...rows.flatMap(row => row.Mounts.filter(mount => mount.Type === "volume").map(mount => mount.Name))]);
  const reference = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
  if (!networks.length || !volumes.length || ![...networks, ...volumes].every(name => reference.test(name))) throw new ProbeError("invalid resource inventory");
  const networkRows = JSON.parse(read("network", "inspect", ...networks));
  const volumeRows = JSON.parse(read("volume", "inspect", ...volumes));
  if (!networkRows.every(row => hashPattern.test(row.Id) && networks.some(ref => ref === row.Id || ref === row.Name)) ||
      !networks.every(ref => networkRows.some(row => ref === row.Id || ref === row.Name)) ||
      !isDeepStrictEqual(volumeRows.map(row => row.Name).sort(), volumes) ||
      !volumeRows.every(row => row.CreatedAt && row.Driver && row.Mountpoint)) throw new ProbeError("incomplete resource inventory");
  for (const row of networkRows) delete row.Containers; // Endpoint attachments do not define network configuration.
  return {
    networks: Object.fromEntries(networkRows.map(row => [row.Id, row])),
    volumes: Object.fromEntries(volumeRows.map(row => [row.Name, row])),
  };
}

function dockerCommand(repository, binary, args, env) {
  const [verb, subcommand] = args;
  const composeConfig = verb === "compose" && subcommand === "--project-directory" && args.includes("config");
  const nativeQuery = verb === "exec" && hashPattern.test(subcommand) &&
    isDeepStrictEqual(args.slice(2, -1), ["psql", "-U", "wasalx", "-d", "wasalx", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c"]) &&
    /^BEGIN READ ONLY; SELECT [\s\S]+; COMMIT;$/u.test(args.at(-1));
  const readOnly = ["info", "ps", "inspect"].includes(verb) || (verb === "image" && subcommand === "inspect") ||
    (["network", "volume"].includes(verb) && ["ls", "inspect"].includes(subcommand)) ||
    (verb === "compose" && subcommand === "version") || composeConfig || nativeQuery;
  if (binary !== "docker" || !readOnly) throw new ProbeError("unexpected native command");
  const result = spawnSync(binary, args, { cwd: repository, env, encoding: "utf8", windowsHide: true,
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) {
    const action = composeConfig ? "compose config" : nativeQuery ? "exec read-only query"
      : ["image", "network", "volume", "compose"].includes(verb) ? `${verb} ${subcommand}` : verb;
    const error = new ProbeError(`docker ${action} failed`);
    error.code = result.error?.code;
    throw error;
  }
  return result.stdout.trim();
}

async function main() {
  let target;
  try {
    const { values } = parseArgs({ options: {
      "project-name": { type: "string", default: "wasalx-probe" },
      "repository": { type: "string", default: process.cwd() },
      "env-file": { type: "string", default: ".env" },
      "compose-file": { type: "string", multiple: true },
      "held-services": { type: "string" },
    } });
    const project = values["project-name"], repository = resolve(values.repository);
    const held = values["held-services"] === "" ? [] : values["held-services"]?.split(",");
    if (!servicePattern.test(project) ||
        (held && (!held.every(name => servicePattern.test(name)) || new Set(held).size !== held.length))) throw new ProbeError("invalid probe arguments");
    const environment = { ...process.env, COMPOSE_PROFILES: "" };
    const context = { project, repository, environment, command: (binary, args, env) => dockerCommand(repository, binary, args, env) };
    const read = (...args) => context.command("docker", args, environment);
    const files = ["compose.yaml", "compose.full.yaml", ...(values["compose-file"] ?? [])];
    const model = JSON.parse(read("compose", "--project-directory", repository, "--env-file", resolve(values["env-file"]),
      ...files.flatMap(path => ["--file", resolve(repository, path)]), ...composeProfiles.flatMap(profile => ["--profile", profile]),
      "--project-name", project, "config", "--no-interpolate", "--no-env-resolution", "--format", "json"));
    const host = await dockerIdentity(context);
    const rows = await inspectOwned(context);
    target = censusFailure(model, rows, held, 37);
    if (target) throw new ProbeError("stack census failed");
    const version = read("compose", "version", "--short");
    const resources = projectResources(read, project, rows);
    const preimages = rows.map(devContainerPreimage);
    const composeHashes = Object.create(null), fields = Object.create(null);
    for (const row of rows) {
      const service = row.Config.Labels[serviceLabel];
      target = { service };
      const image = JSON.parse(read("image", "inspect", row.Image))[0];
      if (image?.Id !== row.Image) throw new ProbeError("image preimage unavailable");
      let rerendered;
      const recordContext = { ...context, command(binary, args, env) {
        const stdout = context.command(binary, args, env);
        if (args[0] === "compose" && args.at(-2) === "--hash") {
          const [name, hash, extra] = words(stdout);
          if (name !== service || !hashPattern.test(hash) || extra || rerendered) throw new ProbeError("invalid Compose service hash");
          rerendered = hash;
        }
        return stdout;
      } };
      // Root filesystem changes matter to rollback, while composePreimage consumes only Compose inputs.
      const labelHash = row.Config.Labels[configHashLabel];
      if (!hashPattern.test(labelHash)) throw new ProbeError("invalid Compose config-hash label");
      try {
        await composePreimage(row, recordContext, image, version, rows);
      } catch (error) {
        // An observed config-hash difference has a native hash and is evidence for the caller to review.
        if (!rerendered || !error.rollbackFields?.includes(`${service}.compose.config-hash`) ||
            !error.rollbackFields.every(field => typeof field === "string" && field.startsWith(`${service}.`) && fieldPattern.test(field.slice(service.length + 1)))) throw error;
        fields[service] = error.rollbackFields;
      }
      if (!rerendered) throw new ProbeError("missing rerendered Compose hash");
      composeHashes[service] = { label_hash: labelHash, rerendered_hash: rerendered };
    }
    target = undefined;
    const sync = await readDevNativeSync(context);
    if (sync.pending !== 0) throw new ProbeError("native membership work is pending");
    const after = await inspectOwned(context);
    target = censusFailure(model, after, held, 37);
    if (target) throw new ProbeError("stack census failed");
    if (!isDeepStrictEqual(after.map(devContainerPreimage), preimages) || !isDeepStrictEqual(await dockerIdentity(context), host) ||
        !isDeepStrictEqual(projectResources(read, project, after), resources)) throw new ProbeError("native preimage changed during scan");
    const containers = Object.fromEntries(preimages.map(({ service, id, image, configSha256, hostConfigSha256 }) =>
      [service, [id, image, configSha256, hostConfigSha256]]));
    process.stdout.write(`${JSON.stringify({ census: "PASS", services: rows.length, rerendered_hashes: Object.keys(composeHashes).length,
      containers, fields, compose_hashes: composeHashes })}\n`);
  } catch (error) {
    process.stderr.write(`${sanitizeProbeError(error, target ?? undefined)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
