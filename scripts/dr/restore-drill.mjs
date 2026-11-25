import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directoryName = "wasalx-control-plane-restore";
const drillIdPattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const containerIdPattern = /^[0-9a-f]{64}$/u;
export const rehearsalLabel = "wasalx.io/rehearsal-id";
const purposeKey = "wasalx.io/purpose";
const purpose = "dr-rehearsal";
export const purposeLabel = `${purposeKey}=${purpose}`;
const ownerFields = `{{.Label "${purposeKey}"}} {{.Label "${rehearsalLabel}"}}`;
export const postgresVolumePath = "/var/lib/postgresql";

export function lockRestoreDrill(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
  // flock locks the open file description shared with Node, so exiting flock leaves the lock held.
  const lock = spawnSync("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "75", "3"], {
    stdio: ["ignore", "ignore", "ignore", fd],
  });
  if (lock.status === 0) return fd;
  closeSync(fd);
  if (lock.status === 75) throw new Error("Another restore drill holds the recovery lock");
  throw new Error("Could not acquire the restore drill lock");
}

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function withLock(action, {
  state = `/var/lib/${directoryName}`, cache = `/var/cache/${directoryName}`,
  lock = lockRestoreDrill, spawn = spawnSync, syncState = syncDirectory,
} = {}) {
  const fd = lock(join(state, "drill.lock"));
  try {
    const pending = join(state, "pending-drill");
    const docker = (args, { timeout, environment = process.env } = {}) => {
      const result = spawn("docker", ["--host", "unix:///run/docker.sock", ...args], {
        encoding: "utf8", timeout, maxBuffer: 2 * 1_024 * 1_024,
        env: { ...environment, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined },
        stdio: ["ignore", "pipe", "pipe", fd],
      });
      return result.error ? { ...result, status: null } : result;
    };
    return await action({ pending, cache, docker, persistPendingPath: () => syncState(state) });
  } finally {
    closeSync(fd);
  }
}

async function readPending(path) {
  const value = await readFile(path, "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (value === null) return null;
  const match = new RegExp(`^(${drillIdPattern})(?: (wasalx-dr-[0-9a-f]{32}-data) (allocating-volume|volume-ready|creating|[0-9a-f]{64}))?\\n$`, "u").exec(value);
  if (!match || (match[2] && match[2] !== `${drillName(match[1])}-data`)) {
    throw new Error("Restore drill ownership record is invalid; operator action is required");
  }
  return { rehearsalId: match[1], phase: match[3] };
}

function drillName(rehearsalId) {
  return `wasalx-dr-${rehearsalId.replaceAll("-", "")}`;
}

function drillResources(rehearsalId, { cache, docker }) {
  const name = drillName(rehearsalId);
  const directory = join(cache, `rehearsal-${rehearsalId}`);
  return { rehearsalId, name, volume: `${name}-data`, directory, docker };
}

function findOwnedContainer({ rehearsalId, name, docker }, expectedId) {
  function list(filter) {
    const result = docker(["container", "ls", "--all", "--no-trunc", "--filter", filter,
      "--format", `{{.ID}} {{.Names}} ${ownerFields}`], { timeout: 30_000 });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      throw new Error("Could not verify restore container ownership");
    }
    return result.stdout.trim();
  }
  const row = list(`label=${rehearsalLabel}=${rehearsalId}`) || (expectedId && list(`id=${expectedId}`));
  if (!row) return null;
  const id = row.split(" ", 1)[0];
  if (!containerIdPattern.test(id) || (expectedId && id !== expectedId) ||
      row !== `${id} ${name} ${purpose} ${rehearsalId}`) {
    throw new Error("Restore container ownership does not match this drill");
  }
  return id;
}

function findOwnedVolume({ docker, volume, rehearsalId }) {
  const result = docker(["volume", "ls", "--filter", `name=^${volume}$`,
    "--format", `{{.Name}} {{.Driver}} ${ownerFields}`], { timeout: 30_000 });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Could not verify restore volume ownership");
  }
  const row = result.stdout.trim();
  if (!row) return false;
  if (row !== `${volume} local ${purpose} ${rehearsalId}`) {
    throw new Error("Restore volume ownership does not match this drill");
  }
  return true;
}

function verifyDataMount(drill, containerId) {
  const { docker, volume } = drill;
  if (!findOwnedVolume(drill)) throw new Error("Could not find the drill-owned restore volume");
  const result = docker(["container", "inspect", "--format", "{{json .Mounts}}", containerId], { timeout: 30_000 });
  if (result.status !== 0 || typeof result.stdout !== "string") throw new Error("Could not verify the restore data mount");
  let mounts;
  try {
    mounts = JSON.parse(result.stdout);
  } catch {
    throw new Error("Could not verify the restore data mount");
  }
  const volumes = Array.isArray(mounts) ? mounts.filter(mount => mount?.Type === "volume") : [];
  const [data] = volumes;
  if (volumes.length !== 1 || data.Name !== volume || data.Destination !== postgresVolumePath || data.RW !== true) {
    throw new Error("Restore data mount does not match the drill-owned volume");
  }
}

async function recordPhase(drill, pending, phase) {
  await writeFile(pending, `${drill.rehearsalId} ${drill.volume} ${phase}\n`, { flush: true });
  drill.phase = phase;
}

async function cleanup(drill, pending, { requireContainer = false, removeScratch }) {
  const { phase, docker, volume } = drill;
  const recordedId = containerIdPattern.test(phase) ? phase : undefined;
  if (phase === "creating" || recordedId) {
    const id = findOwnedContainer(drill, recordedId);
    if (!id && (phase === "creating" || requireContainer)) {
      throw new Error("Could not confirm removal of the disposable restore target");
    }
    if (id) {
      verifyDataMount(drill, id);
      if (!recordedId) await recordPhase(drill, pending, id);
      const removed = docker(["rm", "--force", id], { timeout: 60_000 });
      if (removed.status !== 0 || findOwnedContainer(drill, id)) {
        throw new Error("Could not confirm removal of the disposable restore target");
      }
    }
  }
  if (phase) {
    const owned = findOwnedVolume(drill);
    if (!owned && phase === "allocating-volume") {
      throw new Error("Could not confirm creation or removal of the restore volume");
    }
    if (owned) {
      if (phase === "allocating-volume") await recordPhase(drill, pending, "volume-ready");
      const removed = docker(["volume", "rm", volume], { timeout: 60_000 });
      if (removed.status !== 0 || findOwnedVolume(drill)) {
        throw new Error("Could not confirm removal of the restore volume");
      }
    }
  }
  if (removeScratch) await rm(drill.directory, { recursive: true, force: true });
  await unlink(pending);
}

export function runRestoreDrill(operation, publish, options) {
  return withLock(async context => {
    const { pending } = context;
    const previous = await readPending(pending);
    if (previous) throw new Error(`Restore drill ${previous.rehearsalId} requires interrupted-drill cleanup`);

    const drill = drillResources(randomUUID(), context);
    await writeFile(pending, `${drill.rehearsalId}\n`, { flag: "wx", mode: 0o600, flush: true });
    // A file flush cannot persist its new directory entry across a power loss.
    try {
      await context.persistPendingPath();
    } catch (error) {
      throw new Error(`Could not persist the ownership record for restore drill ${drill.rehearsalId}`, { cause: error });
    }
    drill.createScratch = async () => {
      await mkdir(drill.directory, { mode: 0o700 });
      drill.scratchCreated = true;
    };
    drill.startContainer = async (args, environment) => {
      if (findOwnedVolume(drill)) throw new Error("Restore volume name is already in use");
      await recordPhase(drill, pending, "allocating-volume");
      const volume = drill.docker(["volume", "create", "--driver", "local", "--label", purposeLabel,
        "--label", `${rehearsalLabel}=${drill.rehearsalId}`, drill.volume], { timeout: 30_000 });
      if (volume.status !== 0 || volume.stdout?.trim() !== drill.volume || !findOwnedVolume(drill)) {
        throw new Error("Could not create and verify the drill-owned restore volume");
      }
      await recordPhase(drill, pending, "creating");
      const result = drill.docker(args, { timeout: 180_000, environment });
      const id = result.stdout?.trim();
      if (result.status !== 0 || !containerIdPattern.test(id)) throw new Error("Could not start the disposable restore target");
      await recordPhase(drill, pending, id);
      if (!findOwnedContainer(drill, id)) throw new Error("Could not verify the disposable restore target");
      verifyDataMount(drill, id);
      return id;
    };

    let outcome;
    try {
      outcome = { result: await operation(drill) };
    } catch (error) {
      outcome = { error };
    }
    try {
      await cleanup(drill, pending, { requireContainer: true, removeScratch: drill.scratchCreated });
    } catch (error) {
      const failure = new Error(`Restore drill ${drill.rehearsalId} cleanup failed: ${error.message}`, { cause: error });
      if ("error" in outcome) {
        const original = outcome.error?.message ?? String(outcome.error);
        throw new AggregateError([outcome.error, failure], `${failure.message}. Original failure: ${original}`);
      }
      throw failure;
    }
    if ("error" in outcome) throw outcome.error;
    return await publish(outcome.result);
  }, options);
}

export function recoverRestoreDrill(rehearsalId, options) {
  return withLock(async context => {
    const previous = await readPending(context.pending);
    if (!previous || previous.rehearsalId !== rehearsalId) throw new Error("Interrupted drill ID does not match the pending drill");
    const drill = { ...drillResources(rehearsalId, context), phase: previous.phase };
    await cleanup(drill, context.pending, { removeScratch: true });
  }, options);
}
