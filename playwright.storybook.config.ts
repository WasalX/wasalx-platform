import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const browserPath = process.env.WASALX_VISUAL_BROWSER_PATH;

export default defineConfig({
  testDir: "./tests/visual",
  outputDir: "./test-results/storybook",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: resolve("output", "playwright", "design-system") }]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:6011",
    browserName: "chromium",
    colorScheme: "light",
    deviceScaleFactor: 1,
    headless: true,
    launchOptions: browserPath ? { executablePath: browserPath } : {},
    locale: "en-US",
    screenshot: "only-on-failure",
    timezoneId: "Asia/Riyadh",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: "node scripts/serve-storybook-static.mjs",
    reuseExistingServer: false,
    timeout: 30_000,
    url: "http://127.0.0.1:6011/index.json",
  },
});
