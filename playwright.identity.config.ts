import { defineConfig } from '@playwright/test';

// Isolated native Keycloak coverage; never supplies or records production credentials.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'keycloak-signin.spec.ts',
  outputDir: './output/playwright/identity',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list'], ['json', { outputFile: 'output/playwright/identity-tests.json' }]],
  use: { channel: 'chrome', headless: true, contextOptions: { reducedMotion: 'reduce' }, actionTimeout: 10_000, trace: 'off', video: 'off', screenshot: 'off' },
});
