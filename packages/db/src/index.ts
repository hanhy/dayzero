import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadEnvironment() {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

export function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required. See .env.example.');
  return value;
}

export function createPool() {
  return new pg.Pool({
    connectionString: databaseUrl(),
    max: 5,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
  });
}

export function createDatabase(pool: pg.Pool) {
  return drizzle(pool);
}

export { pg };
