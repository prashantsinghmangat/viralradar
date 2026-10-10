import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.QA_PORT || 4321);

export default defineConfig({
  testDir: './tests',
  // Screenshots are compared by eye, not pixel-diffed, so a stable serial run
  // beats a fast flaky one.
  workers: 4,
  fullyParallel: true,
  reporter: [['list'], ['html', { outputFolder: '../qa/report', open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Deterministic: the fixtures pin "now", so relative times never drift.
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'node qa/serve.mjs',
    cwd: '..',
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
