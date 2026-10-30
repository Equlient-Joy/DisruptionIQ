import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun src/server/index.ts',
    url: 'http://127.0.0.1:3000/api/dashboard',
    reuseExistingServer: !process.env.CI,
    env: {
      DEMO_MODE: 'true',
      PORT: '3000',
    },
    timeout: 30000,
  },
});
