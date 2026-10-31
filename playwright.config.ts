import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run build && bun src/server/index.ts',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    env: {
      DEMO_MODE: 'true',
      DEMO_PASSWORD: 'disruption-demo',
      PORT: '3100',
      APP_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_MODE: 'pglite',
      DATABASE_URL: '',
      PGLITE_PATH: 'memory://',
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '',
      AI_FEATURES_ENABLED: 'false',
      AI_API_KEY: '',
      GEMINI_API_KEY: '',
    },
    timeout: 60000,
  },
});
