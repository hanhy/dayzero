import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from './test-database.ts';

const database = await createTestDatabase('e2e');
try {
  const child = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DAYZERO_E2E_DATABASE_URL: database.url,
        DAYZERO_E2E_MASTER_KEY: randomBytes(32).toString('base64'),
      },
    },
  );
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await database.destroy();
}
