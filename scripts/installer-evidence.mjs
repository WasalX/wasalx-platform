import assert from "node:assert/strict";
import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../", import.meta.url)));
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const registryPattern = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::[0-9]+)?$/u;
const inside = (root, path) => { const part = relative(root, path); return !part || (!part.startsWith("..") && !isAbsolute(part)); };

function pinnedImage(reference) {
  if (typeof reference !== "string") return null;
  const separator = reference.lastIndexOf("@");
  if (separator <= 0 || reference.indexOf("@") !== separator) return null;
  const digest = reference.slice(separator + 1);
  if (!digestPattern.test(digest)) return null;
  let repositoryName = reference.slice(0, separator);
  const slash = repositoryName.lastIndexOf("/");
  const colon = repositoryName.lastIndexOf(":");
  if (colon > slash) repositoryName = repositoryName.slice(0, colon);
  const parts = repositoryName.toLowerCase().split("/");
  if (parts.some((part) => part.length === 0)) return null;
  const first = parts[0];
  const qualified = first.includes(".") || first.includes(":") || first === "localhost";
  let registry = qualified ? parts.shift() : "docker.io";
  if (!registryPattern.test(registry)) return null;
  try {
    // Docker references retain explicit ports, including ports used by HTTP or HTTPS.
    const endpoint = new URL(`docker://${registry}`);
    if (!endpoint.port && (endpoint.hostname === "index.docker.io" || endpoint.hostname === "registry-1.docker.io")) registry = "docker.io";
  } catch {
    return null;
  }
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  if (parts.length === 0) return null;
  return { repository: `${registry}/${parts.join("/")}`, digest };
}

export function repositoryDigestMatches(reference, repoDigest) {
  const declared = pinnedImage(reference);
  const pulled = pinnedImage(repoDigest);
  return Boolean(declared && pulled && declared.repository === pulled.repository && declared.digest === pulled.digest);
}

async function repositoryTarget(logicalPath, createParents = false) {
  assert.ok(typeof logicalPath === "string" && !isAbsolute(logicalPath), "repository artifact path is invalid");
  const segments = logicalPath.replaceAll("\\", "/").split("/");
  assert.ok(segments.length > 0 && segments.every((segment) => segment && segment !== "." && segment !== ".."), "repository artifact path is invalid");
  const root = await realpath(repository);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = resolve(parent, segment);
    let details;
    try {
      details = await lstat(parent);
    } catch (error) {
      if (!createParents || error?.code !== "ENOENT") throw error;
      await mkdir(parent, { mode: 0o700 });
      details = await lstat(parent);
    }
    assert.ok(details.isDirectory() && !details.isSymbolicLink(), `repository artifact path must not contain symlinks: ${logicalPath}`);
    const canonical = await realpath(parent);
    assert.ok(inside(root, canonical), "repository artifact path escapes its root");
  }
  const absolute = resolve(parent, segments.at(-1));
  assert.ok(inside(root, absolute), "repository artifact path escapes its root");
  return { root, absolute };
}

export async function writeRepositoryJson(logicalPath, value, { replace = false } = {}) {
  const { root, absolute } = await repositoryTarget(logicalPath, true);
  let existing;
  try {
    existing = await lstat(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (replace) {
    assert.ok(existing?.isFile() && !existing.isSymbolicLink(), "repository artifact replacement target must be a regular file");
    assert.ok(inside(root, await realpath(absolute)), "repository artifact replacement target escapes its root");
    const temporary = `${absolute}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, absolute);
  } else {
    assert.equal(existing, undefined, `evidence manifest already exists: ${absolute}`);
    await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  const written = await lstat(absolute);
  assert.ok(written.isFile() && !written.isSymbolicLink(), "repository artifact output must be a regular file");
  assert.ok(inside(root, await realpath(absolute)), "repository artifact output escapes its root");
  return absolute;
}
