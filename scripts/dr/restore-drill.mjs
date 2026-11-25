import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directoryName = "wasalx-control-plane-restore";
const drillIdPattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const containerIdPattern = /^[0-9a-f]{64}$/u;
export const rehearsalLabel = "wasalx.io/rehearsal-id";
const purposeKey = "wasalx.io/purpose";
const purpose = "dr-rehearsal";
export const purposeLabel = `${purposeKey}=${purpose}`;
const ownershipFormat = `{{.ID}} {{.Names}} {{.Label "${purposeKey}"}} {{.Label "${rehearsalLabel}"}}`;

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

async function withLock(action, {
  state = `/var/lib/${directoryName}`, cache = `/var/cache/${directoryName}`,
  lock = lockRestoreDrill, spawn = spawnSync,
} = {}) {
  const fd = lock(join(state, "drill.lock"));
  try {
    const pending = join(state, "pending-drill");
    const docker = (args, { timeout, environment = process.env } = {}) => spawn(
      "docker", ["--host", "unix:///run/docker.sock", ...args], {
        encoding: "utf8", timeout, maxBuffer: 2 * 1_024 * 1_024,
        env: { ...environment, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined },
        stdio: ["ignore", "pipe", "pipe", fd],
      });
    return await action({ pending, cache, docker });
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
  const match = new RegExp(`^(${drillIdPattern})(?: ([0-9a-f]{64}))?\\n$`, "u").exec(value);
  if (!match) throw new Error("Restore drill ownership record is invalid; operator action is required");
  return { rehearsalId: match[1], containerId: match[2] };
}

function drillResources(rehearsalId, { cache, docker }) {
  const name = `wasalx-dr-${rehearsalId.replaceAll("-", "")}`;
  const directory = join(cache, `rehearsal-${rehearsalId}`);
  return { rehearsalId, name, directory, docker };
}

function findOwnedContainer({ rehearsalId, name, docker }, expectedId) {
  function list(filter) {
    const result = docker(["container", "ls", "--all", "--no-trunc", "--filter", filter, "--format", ownershipFormat],
      { timeout: 30_000 });
    if (result.status !== 0) throw new Error("Could not verify restore container ownership");
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

async function cleanup(drill, pending, { verifyContainer, requireContainer = false, removeScratch }) {
  if (verifyContainer) {
    const id = findOwnedContainer(drill, drill.containerId);
    if ((requireContainer && !id) ||
        (id && drill.docker(["rm", "--force", "--volumes", id], { timeout: 60_000 }).status !== 0)) {
      throw new Error("Could not confirm removal of the disposable restore target");
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
    drill.createScratch = async () => {
      await mkdir(drill.directory, { mode: 0o700 });
      drill.scratchCreated = true;
    };
    drill.startContainer = async (args, environment) => {
      drill.attempted = true;
      const result = drill.docker(args, { timeout: 180_000, environment });
      const id = result.stdout?.trim();
      if (result.status !== 0 || !containerIdPattern.test(id)) throw new Error("Could not start the disposable restore target");
      drill.containerId = id;
      await writeFile(pending, `${drill.rehearsalId} ${id}\n`, { flush: true });
      if (!findOwnedContainer(drill, id)) throw new Error("Could not verify the disposable restore target");
      return id;
    };

    let result;
    try {
      result = await operation(drill);
    } finally {
      try {
        await cleanup(drill, pending, {
          verifyContainer: drill.attempted, requireContainer: drill.attempted, removeScratch: drill.scratchCreated,
        });
      } catch (error) {
        throw new Error(`Restore drill ${drill.rehearsalId} cleanup failed: ${error.message}`, { cause: error });
      }
    }
    return await publish(result);
  }, options);
}

export function recoverRestoreDrill(rehearsalId, options) {
  return withLock(async context => {
    const previous = await readPending(context.pending);
    if (!previous || previous.rehearsalId !== rehearsalId) throw new Error("Interrupted drill ID does not match the pending drill");
    const drill = { ...drillResources(rehearsalId, context), containerId: previous.containerId };
    await cleanup(drill, context.pending, { verifyContainer: true, removeScratch: true });
  }, options);
}
