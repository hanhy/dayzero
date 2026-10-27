import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../apps/server/src/app.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('readiness versus liveness', () => {
  it('keeps liveness online and fails readiness when the database is unavailable', async () => {
    const pool = {
      query: async () => {
        throw new Error('unavailable');
      },
    } as unknown as Pool;
    const app = createApp(pool);
    apps.push(app);
    expect((await app.inject('/api/health/live')).statusCode).toBe(200);
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      database: 'unavailable',
      migrations: 'unknown',
    });
  });
  it('does not claim readiness before migrations have run', async () => {
    const pool = {
      query: async () => ({ rows: [{ ready: false }] }),
    } as unknown as Pool;
    const app = createApp(pool);
    apps.push(app);
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      database: 'ready',
      migrations: 'pending',
    });
  });
});
