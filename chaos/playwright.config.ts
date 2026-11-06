import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests/unit',
  projects: [{ name: 'unit', testDir: '../tests/unit' }],
  reporter: 'line',
  workers: 1,
});
