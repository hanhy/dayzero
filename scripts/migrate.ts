import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createPool, databaseUrl, loadEnvironment } from '@dayzero/db';

loadEnvironment();

const pool = createPool();
const client = await pool.connect();
const directory = fileURLToPath(
  new URL('../packages/db/migrations/', import.meta.url),
);
try {
  await client.query('SELECT pg_advisory_lock(725001)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of (await readdir(directory))
    .filter((s) => s.endsWith('.sql'))
    .sort()) {
    const sql = await readFile(`${directory}/${name}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0]?.checksum !== checksum)
        throw new Error(`Applied migration changed: ${name}`);
      console.log(`unchanged ${name}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)',
        [name, checksum],
      );
      await client.query('COMMIT');
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  const saver = PostgresSaver.fromConnString(databaseUrl());
  try {
    await saver.setup();
  } finally {
    await saver.end();
  }
  console.log('LangGraph checkpoints ready');
} finally {
  await client.query('SELECT pg_advisory_unlock(725001)');
  client.release();
  await pool.end();
}
