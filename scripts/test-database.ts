import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pg, databaseUrl, loadEnvironment } from '@dayzero/db';

export async function createTestDatabase(prefix = 'm1') {
  loadEnvironment();
  const admin = new pg.Pool({
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 3000,
  });
  const name = `dayzero_${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  if (!/^dayzero_[a-z0-9]+_[a-f0-9]{12}$/.test(name))
    throw new Error('Invalid test database name');
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/migrate.ts'],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    if (result.status !== 0)
      throw new Error(`Test migration failed: ${result.stderr}`);
  } catch (error) {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  return {
    name,
    url: url.toString(),
    async destroy() {
      try {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
