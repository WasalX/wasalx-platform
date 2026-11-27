import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const sanitizer = fileURLToPath(
  new URL("./public-browser-trace.py", import.meta.url),
);

export function syntheticBrowserTrace(browser, base, output) {
  const enabled = process.env.WASALX_SYNTHETIC_UI_TRACE === "1";

  return {
    async newContext(options) {
      if (enabled && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(base)) {
        throw new Error(
          "Public browser traces require a loopback Storybook fixture",
        );
      }
      const context = await browser.newContext(options);
      // Playwright couples DOM snapshots to raw network recording.
      if (enabled)
        await context.tracing.start({
          snapshots: false,
          screenshots: false,
          sources: false,
        });
      return context;
    },
    async closeContext(context) {
      if (enabled) await context.tracing.stop();
      await context.close();
    },
    async retainFailure() {
      if (!enabled) return;
      try {
        const scratch = await mkdtemp(join(tmpdir(), "wasalx-browser-trace-"));
        try {
          for (const [index, context] of browser.contexts().entries()) {
            const raw = join(scratch, "trace.zip");
            await context.tracing.stop({ path: raw });
            await run("python3", [
              "-I",
              "-B",
              sanitizer,
              raw,
              join(output, `child-trace-${index + 1}.zip`),
            ]);
          }
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      } catch {
        process.stderr.write(
          "Unable to retain the sanitized child browser trace.\n",
        );
      }
    },
  };
}
