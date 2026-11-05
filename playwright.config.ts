import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3100);
const CI = !!process.env.CI;

export default defineConfig({
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'unit', testDir: 'tests/unit' },
    { name: 'api', testDir: 'tests/api' },
    {
      name: 'e2e',
      testDir: 'tests/e2e',
      // PW_CHANNEL lets you reuse an installed browser locally, e.g. PW_CHANNEL=msedge.
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL },
    },
  ],
  webServer: {
    command: 'node src/server.ts',
    url: `http://localhost:${PORT}/api/health`,
    env: { PORT: String(PORT), LLM_PROVIDER: process.env.LLM_PROVIDER ?? 'mock' },
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
});
