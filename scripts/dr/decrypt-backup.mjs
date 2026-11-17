#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateBackupManifest } from "./contracts.mjs";

async function evidence(file) {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Recovery input must be a regular file");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return { size: details.size, sha256: hash.digest("hex") };
}

export async function decryptBackup(manifestFile, ciphertextFile, identityFile, outputFile) {
  for (const file of [manifestFile, ciphertextFile, identityFile]) {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Recovery input must be a regular file");
  }
  if ((await lstat(manifestFile)).size > 1_048_576) throw new Error("Backup manifest exceeds evidence limit");
  const manifest = validateBackupManifest(JSON.parse(await readFile(manifestFile, "utf8")));
  if (manifest.storage.encryption.mode !== "CLIENT_ENVELOPE") throw new Error("Client-encrypted manifest required");
  const ciphertext = await evidence(ciphertextFile);
  if (ciphertext.size !== manifest.artifact.ciphertextSizeBytes || ciphertext.sha256 !== manifest.artifact.ciphertextSha256) throw new Error("Ciphertext does not match manifest");
  const recipient = spawnSync("age-keygen", ["-y", resolve(identityFile)], { encoding: "utf8", timeout: 10_000 });
  if (recipient.status !== 0 || `key:${recipient.stdout.trim()}` !== manifest.storage.encryption.keyReference) throw new Error("Recovery identity does not match public recipient");
  // Exclusive creation prevents replacing an existing recovery artifact.
  const output = await open(outputFile, "wx", 0o600);
  let verified = false;
  try {
    const result = spawnSync("age", ["--decrypt", "--identity", resolve(identityFile), resolve(ciphertextFile)], {
      stdio: ["ignore", output.fd, "ignore"], timeout: 3_600_000,
    });
    if (result.status !== 0) throw new Error("Backup decryption failed");
    await output.sync();
    const plaintext = await evidence(outputFile);
    if (plaintext.size !== manifest.artifact.sizeBytes || plaintext.sha256 !== manifest.artifact.plaintextSha256) throw new Error("Plaintext does not match manifest");
    verified = true;
  } finally {
    await output.close();
    if (!verified) await rm(outputFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6) throw new Error("Usage: decrypt-backup.mjs MANIFEST CIPHERTEXT PRIVATE_IDENTITY NEW_DUMP");
  await decryptBackup(...process.argv.slice(2));
  process.stdout.write("Backup decrypted and both checksums verified. Run the isolated restore rehearsal.\n");
}
