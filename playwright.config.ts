import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 40_000,
  use: {
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    channel: 'chrome',
  },
  webServer: [
    {
      command: 'npm run dev -w @dayzero/server',
      url: 'http://127.0.0.1:3199/api/health/live',
      env: { PORT: '3199' },
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -w @dayzero/web -- --port 5199',
      url: 'http://127.0.0.1:5199',
      env: { DAYZERO_API_URL: 'http://127.0.0.1:3199' },
      reuseExistingServer: false,
    },
  ],
});
