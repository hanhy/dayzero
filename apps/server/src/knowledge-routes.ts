import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Type, type Static } from '@sinclair/typebox';
import {
  Id,
  OperationSchema,
  VersionOperationSchema,
  SaveDraftSchema,
  SaveNodeSchema,
  CommitSchema,
  CreateRelationSchema,
  SaveRelationSchema,
  RestoreVersionSchema,
  ImportMarkdownSchema,
  BackupSchema,
  RestoreBackupSchema,
  ProfileInputSchema,
} from '@dayzero/contracts';
import { KnowledgeService, ApiError } from './knowledge-service.ts';
import { Backups, markdownFile, parseMarkdown } from './backup.ts';
import { ModelProfiles } from './model-profiles.ts';

const idParams = Type.Object({ id: Id }, { additionalProperties: false });
export function registerKnowledgeRoutes(
  app: FastifyInstance,
  pool: Pool,
  masterKey?: string,
) {
  const service = new KnowledgeService(pool),
    backups = new Backups(service),
    models = new ModelProfiles(pool, masterKey);
  app.get('/api/knowledge', () => service.library());
  const query = Type.Object(
    { q: Type.String({ maxLength: 200 }) },
    { additionalProperties: false },
  );
  app.get<{ Querystring: Static<typeof query> }>(
    '/api/knowledge/search',
    { schema: { querystring: query } },
    (request) => service.search(request.query.q),
  );
  app.post<{ Body: Static<typeof OperationSchema> }>(
    '/api/drafts',
    { schema: { body: OperationSchema } },
    (request) => service.createDraft(request.body.operationId),
  );
  app.put<{ Params: { id: string }; Body: Static<typeof SaveDraftSchema> }>(
    '/api/drafts/:id',
    { schema: { params: idParams, body: SaveDraftSchema } },
    (request) => service.saveDraft(request.params.id, request.body),
  );
  app.put<{ Params: { id: string }; Body: Static<typeof SaveNodeSchema> }>(
    '/api/nodes/:id',
    { schema: { params: idParams, body: SaveNodeSchema } },
    (request) => service.saveNode(request.params.id, request.body),
  );
  app.post<{ Params: { id: string }; Body: Static<typeof CommitSchema> }>(
    '/api/drafts/:id/commit',
    { schema: { params: idParams, body: CommitSchema } },
    (request) => service.commitDraft(request.params.id, request.body),
  );
  app.get<{ Params: { id: string } }>(
    '/api/nodes/:id/history',
    { schema: { params: idParams } },
    (request) => service.history(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    '/api/relations/:id/history',
    { schema: { params: idParams } },
    (request) => service.relationHistory(request.params.id),
  );
  app.post<{
    Params: { id: string };
    Body: Static<typeof RestoreVersionSchema>;
  }>(
    '/api/nodes/:id/restore-version',
    { schema: { params: idParams, body: RestoreVersionSchema } },
    (request) => service.restoreVersion(request.params.id, request.body),
  );
  app.post<{ Body: Static<typeof CreateRelationSchema> }>(
    '/api/relations',
    { schema: { body: CreateRelationSchema } },
    (request) => service.createRelation(request.body),
  );
  app.put<{ Params: { id: string }; Body: Static<typeof SaveRelationSchema> }>(
    '/api/relations/:id',
    { schema: { params: idParams, body: SaveRelationSchema } },
    (request) => service.saveRelation(request.params.id, request.body),
  );
  for (const [plural, kind] of [
    ['nodes', 'node'],
    ['drafts', 'draft'],
    ['relations', 'relation'],
  ] as const) {
    for (const action of ['delete', 'restore'] as const) {
      app.post<{
        Params: { id: string };
        Body: Static<typeof VersionOperationSchema>;
      }>(
        `/api/${plural}/:id/${action}`,
        { schema: { params: idParams, body: VersionOperationSchema } },
        (request) =>
          service.trash(
            kind,
            request.params.id,
            request.body,
            action === 'restore',
          ),
      );
    }
  }
  app.get<{ Params: { id: string } }>(
    '/api/nodes/:id/markdown',
    { schema: { params: idParams } },
    async (request, reply) => {
      const node = await service.node(pool, request.params.id);
      const filename = `${node.title.replace(/[\u0000-\u001f/\\"]/g, '_')}.md`;
      return reply
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .type('text/markdown; charset=utf-8')
        .send(markdownFile(node));
    },
  );
  app.post<{ Body: Static<typeof ImportMarkdownSchema> }>(
    '/api/import/markdown',
    { schema: { body: ImportMarkdownSchema } },
    (request) =>
      service.createDraft(
        request.body.operationId,
        parseMarkdown(request.body.filename, request.body.text),
      ),
  );
  app.get('/api/backups', async (_request, reply) =>
    reply
      .header(
        'Content-Disposition',
        'attachment; filename="dayzero-backup.json"',
      )
      .send(await service.backup()),
  );
  const preview = Type.Object(
    { backup: BackupSchema },
    { additionalProperties: false },
  );
  app.post<{ Body: Static<typeof preview> }>(
    '/api/backups/preview',
    { schema: { body: preview } },
    (request) => backups.preview(request.body.backup),
  );
  app.post<{ Body: Static<typeof RestoreBackupSchema> }>(
    '/api/backups/restore',
    { schema: { body: RestoreBackupSchema } },
    (request) => backups.restore(request.body.backup, request.body.operationId),
  );
  app.get('/api/models', () => models.list());
  app.put<{ Params: { id: string }; Body: Static<typeof ProfileInputSchema> }>(
    '/api/models/:id',
    { schema: { params: idParams, body: ProfileInputSchema } },
    (request) => models.save(request.params.id, request.body),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/models/:id',
    { schema: { params: idParams } },
    (request) => models.remove(request.params.id),
  );

  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
    };
    const status =
      err instanceof ApiError
        ? err.statusCode
        : err.validation
          ? 400
          : err.code === '23505'
            ? 409
            : err.code === '23503' || err.code === '23514'
              ? 400
              : err.statusCode === 413
                ? 413
                : 500;
    const message =
      err instanceof ApiError
        ? err.message
        : err.validation
          ? '请求格式不正确，请检查必填字段与长度'
          : status === 409
            ? '记录已存在或与现有记录冲突'
            : status === 400
              ? '数据引用或约束无效'
              : status === 413
                ? '文件过大，请拆分后导入'
                : '保存失败，请稍后重试';
    if (status === 500)
      request.log.error(
        { code: err.code ?? 'internal' },
        'knowledge request failed',
      );
    void reply.code(status).send({ error: message });
  });
}
