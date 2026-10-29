import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { HealthResponse } from '@dayzero/contracts';
import { registerExplanationRoutes } from './explanation-routes.ts';
import { registerIngestionRoutes } from './ingestion-routes.ts';
import { registerKnowledgeRoutes } from './knowledge-routes.ts';

export function createApp(
  pool: Pool,
  options: { masterKey?: string; logging?: boolean } = {},
) {
  const app = Fastify({
    bodyLimit: 16 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    logger:
      options.logging === false
        ? false
        : { redact: ['req.headers.authorization', 'req.headers.cookie'] },
  });
  app.get('/api/health/live', async () => ({ status: 'ok', milestone: 'M2' }));
  registerKnowledgeRoutes(app, pool, options.masterKey);
  registerIngestionRoutes(app, pool, options.masterKey);
  registerExplanationRoutes(app, pool, options.masterKey);
  app.get('/api/m0/evidence', async () => {
    const reports = await Promise.all(
      ['workflow', 'clustering'].map(async (name) => {
        try {
          const path = new URL(
            `../../../artifacts/${name}.json`,
            import.meta.url,
          );
          const report = JSON.parse(await readFile(path, 'utf8'));
          return [
            name,
            {
              status: report.status === 'passed' ? 'passed' : 'pending',
              checkedAt: report.checkedAt,
            },
          ] as const;
        } catch {
          return [name, { status: 'pending' }] as const;
        }
      }),
    );
    return Object.fromEntries(reports);
  });
  app.get('/api/health', async (_request, reply) => {
    let payload: HealthResponse;
    try {
      const result = await pool.query<{ ready: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema='knowledge' AND table_name='ingestion_runs'
      ) AND EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS ready`);
      const ready = result.rows[0]?.ready === true;
      payload = {
        status: ready ? 'ok' : 'degraded',
        database: 'ready',
        migrations: ready ? 'ready' : 'pending',
        milestone: 'M2',
      };
    } catch {
      payload = {
        status: 'degraded',
        database: 'unavailable',
        migrations: 'unknown',
        milestone: 'M2',
      };
    }
    return reply.code(payload.status === 'ok' ? 200 : 503).send(payload);
  });
  const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(root)) app.register(fastifyStatic, { root });
  return app;
}
