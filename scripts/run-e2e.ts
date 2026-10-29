import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from './test-database.ts';

const m2 = process.argv.includes('--m2');
const masterKey = randomBytes(32).toString('base64');
const database = await createTestDatabase(m2 ? 'm2e2e' : 'e2e');
const worker = m2
  ? spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/index.ts'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: database.url,
        MODEL_MASTER_KEY: masterKey,
      },
    })
  : null;
try {
  const child = spawn(
    process.execPath,
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      ...process.argv.slice(2).filter((arg) => arg !== '--m2'),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DAYZERO_E2E_DATABASE_URL: database.url,
        DAYZERO_E2E_MASTER_KEY: masterKey,
        DAYZERO_M2_E2E: m2 ? '1' : '0',
      },
    },
  );
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.kill('SIGKILL');
        resolve();
      }, 12000);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await database.destroy();
}
