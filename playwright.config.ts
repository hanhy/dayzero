import { defineConfig } from '@playwright/test';

const databaseUrl = process.env.DAYZERO_E2E_DATABASE_URL;
if (!databaseUrl)
  throw new Error('Use npm run test:e2e to create an isolated test database.');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch:
    process.env.DAYZERO_M2_E2E === '1' ? '**/ingestion.m2.ts' : '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
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
      env: {
        PORT: '3199',
        DATABASE_URL: databaseUrl,
        MODEL_MASTER_KEY: process.env.DAYZERO_E2E_MASTER_KEY ?? '',
      },
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
