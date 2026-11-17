import assert from "node:assert/strict";
import { appendFileSync, lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const browserUploadRoots = [
  "output/playwright/application/",
  "output/playwright/application-en/",
  "output/playwright/design-system/",
  "output/playwright/inbox/synthetic/",
  "output/release-evidence/",
  "test-results/storybook/",
  "storybook-static/",
];
// Keep only the compact reports and receipts in the per-run evidence archive.
// HTML reports, traces, videos and scratch output remain failure diagnostics.
export const browserEvidenceUploadRoots = [
  "output/release-evidence/",
  "output/playwright/application/shard-inventory.json",
  ...["en", "ar"].flatMap(locale => [1, 2, 3].map(shard => `output/playwright/application/${locale}/shard-${shard}/`)),
  "output/playwright/inbox/synthetic/",
];
export const browserReleaseUploadRoots = browserEvidenceUploadRoots;
export const browserDiagnosticsUploadRoots = browserUploadRoots.filter(root => !browserEvidenceUploadRoots.includes(root));
export const releaseEvidenceArchiveLimitBytes = 1_048_576;
// Checked-in visual baselines total 1,394,989 bytes; the shard/report estimate is at least 1.35 MB.
// shortcut: provisional, finalize from the next candidate's first sharded run measured size + margin
export const compactBrowserArchiveLimitBytes = 64 * 1024 * 1024;
export const compactBrowserArchiveLimitFinalized = false;
export const browserUploadBudgets = { release: releaseEvidenceArchiveLimitBytes, compact: compactBrowserArchiveLimitBytes, diagnostics: 268_435_456 };
const role = "(?:tenant_owner|tenant_admin|supervisor|agent|auditor)";
const marker = new RegExp(`^(?:output/playwright/application/(?:en|ar)/results/${role}|output/playwright/application-en/en/results/${role}|test-results/storybook)/\\.last-run\\.json$`, "u");
const secretName = /^(?:secure|secrets?|credentials?|storage[-_]?state|auth[-_]?state|id_rsa|id_ed25519)(?:\.[^/]*)?$|\.(?:key|pem|p12|pfx|jks)$/iu;

// Filename-only check: never read or print artifact contents, and never follow links.
export function assertBrowserUploadScope(workspace = process.cwd(), {
  roots = browserUploadRoots, maxBytes = browserUploadBudgets.diagnostics, onBytes,
} = {}) {
  const root = resolve(workspace);
  let files = 0;
  let bytes = 0;
  function stat(path) {
    try { return lstatSync(path); } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  function inspect(relative, budget, rootState, state = stat(resolve(root, relative))) {
    if (!state) return; // Failed/unfinished test phases may not have produced a root.
    assert(!state.isSymbolicLink(), "Browser upload rejects symlinks");
    const name = relative.split("/").at(-1);
    assert(!secretName.test(name), "Browser upload rejects credential paths");
    if (state.isDirectory()) {
      assert(!name.startsWith("."), `Browser upload rejects hidden directories: ${relative}`);
      for (const child of readdirSync(resolve(root, relative))) inspect(`${relative}/${child}`, budget, rootState);
    } else {
      assert(state.isFile(), "Browser upload requires regular files");
      assert(!name.startsWith(".") || marker.test(relative), "Browser upload rejects unknown hidden files");
      files += 1;
      bytes += state.size;
      rootState.bytes += state.size;
      assert(bytes <= maxBytes, `Browser upload byte budget exceeded: uncompressed bytes ${bytes} > limit ${maxBytes} bytes`);
      assert(rootState.bytes <= budget, `Browser upload root byte budget exceeded: ${rootState.bytes} > ${budget} bytes`);
    }
  }
  for (const uploadRoot of roots) {
    const parts = uploadRoot.replace(/\/$/u, "").split("/");
    // Inspect ancestors too: a safe-looking root must not traverse a linked directory.
    for (let index = 1; index < parts.length; index += 1) {
      const state = stat(resolve(root, ...parts.slice(0, index)));
      if (!state) break;
      assert(state.isDirectory() && !state.isSymbolicLink(), "Browser upload rejects linked or non-directory ancestors");
    }
    const rootBudget = uploadRoot === "output/release-evidence/" ? releaseEvidenceArchiveLimitBytes : maxBytes;
    inspect(parts.join("/"), rootBudget, { bytes: 0 });
  }
  onBytes?.(bytes);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const requireFinalized = args.includes("--require-finalized");
    const modes = args.filter(value => value !== "--require-finalized");
    assert(modes.length <= 1 && modes.every(value => ["--release", "--diagnostics"].includes(value)), "Usage: browser-upload-scope.mjs [--release|--diagnostics] [--require-finalized]");
    const mode = modes[0] ?? "--release";
    const diagnostics = mode === "--diagnostics";
    assert(!(diagnostics && requireFinalized), "Usage: browser-upload-scope.mjs [--release|--diagnostics] [--require-finalized]");
    if (requireFinalized) assert.equal(compactBrowserArchiveLimitFinalized, true,
      "compact browser archive limit is provisional; finalize it from measured sharded output before accepting this check");
    const maxBytes = diagnostics ? browserUploadBudgets.diagnostics : browserUploadBudgets.compact;
    let uncompressedBytes = 0;
    const files = assertBrowserUploadScope(process.cwd(), {
      roots: diagnostics ? browserDiagnosticsUploadRoots : browserReleaseUploadRoots, maxBytes,
      onBytes: bytes => { uncompressedBytes = bytes; },
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `files=${files}\n`);
    console.log(`Browser upload scope verified: ${files} files, uncompressed bytes ${uncompressedBytes}, budget ${maxBytes} bytes`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
