// Synthetic UI bridge acceptance only; native/provider evidence is separate.
// The existing Playwright Storybook webServer owns startup and teardown.
import { test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
for (const [surface, script] of [["inbox", "tests/inbox-browser.mjs"], ["groups", "tests/group-inbox-browser.mjs"], ["administration", "tests/admin-browser.mjs"], ["service-access", "tests/service-access-browser.mjs"], ["privacy", "tests/privacy-target-browser.mjs"]] as const) {
  test(`synthetic ${surface} operators complete browser journeys`, async ({ baseURL }) => {
    test.setTimeout(240_000);
    const child = spawn(process.execPath, [script], {
      cwd: repository, stdio: "inherit", windowsHide: true,
      env: { ...process.env, WASALX_STORYBOOK_URL: baseURL,
        WASALX_SYNTHETIC_UI_OUTPUT: `output/playwright/inbox/synthetic/${surface}` },
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 230_000);
    try {
      const [code, signal] = await once(child, "exit");
      if (code !== 0 || signal) throw new Error(`Synthetic ${surface} browser gate failed (${signal ?? code})`);
    } finally {
      clearTimeout(timeout);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
    }
  });
}
