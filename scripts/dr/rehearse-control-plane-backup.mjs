import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CONTROL_BACKUP_PREFIX, DR_OBJECTIVES, validateBackupManifest } from "./contracts.mjs";

const execute = promisify(execFile);
const manifestSuffix = ".manifest.json";

export async function rehearseControlPlaneBackup(environment, { run = execute, now = () => new Date() } = {}) {
  const {
    BACKUP_S3_BUCKET: bucket, BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_REGION: region,
    BACKUP_AGE_IDENTITY: identity, CACHE_DIRECTORY: scratch, STATE_DIRECTORY: evidence,
  } = environment;
  if (![bucket, endpoint, region, scratch, evidence].every(Boolean)) {
    throw new Error("Restore requires a backup bucket, endpoint, region, scratch and evidence directories");
  }
  const origin = URL.parse(endpoint);
  if (origin?.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Restore requires an HTTPS S3 endpoint without credentials or URL parameters");
  }
  const aws = ["--no-cli-pager", "--endpoint-url", endpoint, "--region", region, "s3api"];
  const directory = await mkdtemp(join(scratch, "rehearsal-"));
  const manifestFile = join(directory, "manifest.json");
  const artifactFile = join(directory, "artifact");
  const temporaryEvidence = join(directory, "evidence.json");
  const output = join(evidence, `control-plane-${randomUUID()}.json`);

  async function command(program, args, stage, timeout = 3_600_000) {
    try {
      return (await run(program, args, { env: environment, timeout, windowsHide: true })).stdout;
    } catch {
      throw new Error(`${stage} failed`);
    }
  }

  async function getObject(key, destination, { version, range } = {}) {
    const result = await command("aws", [
      ...aws, "get-object", "--bucket", bucket, "--key", key,
      ...(version ? [`--version-id=${version}`] : []),
      ...(range ? ["--range", range] : []),
      "--query", "VersionId", "--output", "json", destination,
    ], "Backup object download", range ? 60_000 : 3_600_000);
    const observed = JSON.parse(result);
    if (typeof observed !== "string" || !observed || /^(null|none|unversioned)$/iu.test(observed) ||
        (version && observed !== version)) {
      throw new Error("Backup object version could not be verified");
    }
    return observed;
  }

  let result;
  let receipt;
  try {
    const manifestKey = JSON.parse(await command("aws", [
      ...aws, "list-objects-v2", "--bucket", bucket, "--prefix", CONTROL_BACKUP_PREFIX,
      "--query", "(Contents || `[]`) | max_by([?ends_with(Key, '.manifest.json')], &Key).Key",
      "--output", "json",
    ], "Backup manifest listing", 60_000));
    if (typeof manifestKey !== "string" || !manifestKey.startsWith(CONTROL_BACKUP_PREFIX) ||
        !manifestKey.endsWith(manifestSuffix)) {
      throw new Error("No complete control-plane backup manifest was found");
    }
    const manifestVersion = await getObject(manifestKey, manifestFile, { range: "bytes=0-1048576" });
    if ((await stat(manifestFile)).size > 1_048_576) throw new Error("Backup manifest exceeds the evidence limit");
    const source = JSON.parse(await readFile(manifestFile, "utf8"));
    const checkedAt = now();
    const manifest = validateBackupManifest(source, checkedAt);
    if (manifest.workload.kind !== "control-plane" || source.manifestSha256 !== manifest.manifestSha256 ||
        manifest.storage.bucket !== bucket || `${manifest.storage.objectKey}${manifestSuffix}` !== manifestKey) {
      throw new Error("Control-plane manifest does not match the selected backup");
    }
    if (checkedAt - Date.parse(manifest.completedAt) > DR_OBJECTIVES.backupFreshnessHours * 3_600_000) {
      throw new Error("Latest control-plane backup is stale");
    }
    const encrypted = manifest.storage.encryption.mode === "CLIENT_ENVELOPE";
    if (encrypted && !identity) throw new Error("Client-encrypted backup requires a recovery identity file");

    await getObject(manifest.storage.objectKey, artifactFile, { version: manifest.storage.objectVersionId });
    let dump = artifactFile;
    if (encrypted) {
      dump = join(directory, "restore.dump");
      await command(process.execPath, [fileURLToPath(new URL("decrypt-backup.mjs", import.meta.url)),
        manifestFile, artifactFile, identity, dump], "Backup decryption and integrity verification");
    }
    await command(process.execPath, [fileURLToPath(new URL("rehearse-postgres-restore.mjs", import.meta.url)),
      "--manifest", manifestFile, "--artifact", dump, "--output", temporaryEvidence], "Disposable PostgreSQL restore", 4_500_000);
    receipt = await readFile(temporaryEvidence);
    result = { backupId: manifest.backupId, manifestVersion, artifactVersion: manifest.storage.objectVersionId, evidence: output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await writeFile(output, receipt, { flag: "wx", mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    process.stdout.write(`${JSON.stringify(await rehearseControlPlaneBackup(process.env))}\n`);
  } catch (error) {
    const message = error instanceof SyntaxError ? "Backup metadata is not valid JSON" : error.message;
    process.stderr.write(`Control-plane restore rehearsal failed: ${message}\n`);
    process.exitCode = 1;
  }
}
