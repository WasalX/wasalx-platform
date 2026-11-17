import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const explicitPath = process.env.WASALX_VISUAL_BROWSER_PATH;
const candidates = [
  explicitPath,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

let browserPath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    browserPath = candidate;
    break;
  } catch {
    // Continue until a real executable is found. A Playwright package path can
    // exist in metadata even when the optional browser binary was not installed.
  }
}

if (!browserPath) {
  const message = "SKIP design-system visual regression: no Chromium-compatible browser executable is available.";
  if (process.env.WASALX_REQUIRE_VISUAL === "1" || process.argv.includes("--require-browser")) {
    process.stderr.write(`${message} WASALX_REQUIRE_VISUAL=1 makes this a required gate.\n`);
    process.exit(1);
  }
  process.stdout.write(`${message} Set WASALX_REQUIRE_VISUAL=1 in release CI to fail closed.\n`);
  process.exit(0);
}

await access("storybook-static/index.json").catch(() => {
  process.stderr.write("Storybook static output is missing. Run pnpm build:storybook before the visual gate.\n");
  process.exit(1);
});

const args = [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test", "--config", "playwright.storybook.config.ts", ...process.argv.slice(2).filter(value => value !== "--require-browser")];
if (process.env.WASALX_UPDATE_VISUALS === "1") args.push("--update-snapshots");

const result = await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, WASALX_VISUAL_BROWSER_PATH: browserPath },
    stdio: "inherit",
  });
  child.on("error", rejectPromise);
  child.on("exit", (code, signal) => resolvePromise({ code, signal }));
});

if (result.signal) {
  process.stderr.write(`Visual regression process ended by ${result.signal}.\n`);
  process.exit(1);
}
process.exit(result.code ?? 1);
