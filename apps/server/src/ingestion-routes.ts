import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Type, type Static } from '@sinclair/typebox';
import {
  Id,
  StartIngestionSchema,
  ReviewSchema,
  ConfirmIngestionSchema,
} from '@dayzero/contracts';
import { IngestionService } from './ingestion-service.ts';
const params = Type.Object({ id: Id }, { additionalProperties: false });
export function registerIngestionRoutes(
  app: FastifyInstance,
  pool: Pool,
  masterKey?: string,
) {
  const service = new IngestionService(pool, masterKey);
  app.post<{
    Params: { id: string };
    Body: Static<typeof StartIngestionSchema>;
  }>(
    '/api/drafts/:id/analyze',
    { schema: { params, body: StartIngestionSchema } },
    (req) => service.start(req.params.id, req.body),
  );
  app.get<{ Params: { id: string } }>(
    '/api/drafts/:id/ingestion',
    { schema: { params } },
    (req) => service.latest(req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    '/api/ingestion/:id',
    { schema: { params } },
    (req) => service.get(req.params.id),
  );
  app.put<{ Params: { id: string }; Body: Static<typeof ReviewSchema> }>(
    '/api/ingestion/:id/review',
    { schema: { params, body: ReviewSchema } },
    (req) => service.review(req.params.id, req.body),
  );
  app.post<{
    Params: { id: string };
    Body: Static<typeof ConfirmIngestionSchema>;
  }>(
    '/api/ingestion/:id/confirm',
    { schema: { params, body: ConfirmIngestionSchema } },
    (req) => service.confirm(req.params.id, req.body.expectedReviewVersion),
  );
  for (const action of ['retry', 'cancel'] as const)
    app.post<{ Params: { id: string } }>(
      `/api/ingestion/:id/${action}`,
      { schema: { params } },
      (req) => service[action](req.params.id),
    );
  app.post<{ Params: { id: string } }>(
    '/api/models/:id/test',
    { schema: { params } },
    (req) => service.gateway.test(req.params.id),
  );
}
