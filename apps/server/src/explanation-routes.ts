import { once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  ExplainWordSchema,
  explanationPrompt,
  type ExplainWordInput,
} from '@dayzero/contracts';
import { ModelProfiles } from './model-profiles.ts';
import { ModelGateway } from './model-gateway.ts';
import { ApiError } from './knowledge-service.ts';
export function registerExplanationRoutes(
  app: FastifyInstance,
  pool: Pool,
  masterKey?: string,
) {
  const profiles = new ModelProfiles(pool, masterKey),
    gateway = new ModelGateway(pool, profiles);
  app.post<{ Body: ExplainWordInput }>(
    '/api/explanations',
    { schema: { body: ExplainWordSchema } },
    async (req, reply) => {
      const text = req.body.text.trim();
      if (!text) throw new ApiError(400, '请先选中要解释的文字');
      const connection = await profiles.connection(req.body.profileId, 'chat');
      if (req.raw.aborted || reply.raw.destroyed) {
        reply.hijack();
        return;
      }
      const controller = new AbortController();
      const close = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.on('close', close);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();
      const send = async (event: string, data: unknown) => {
        if (controller.signal.aborted || reply.raw.destroyed) return;
        if (
          !reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        )
          await once(reply.raw, 'drain', { signal: controller.signal });
      };
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed && !controller.signal.aborted)
          reply.raw.write(': keep-alive\n\n');
      }, 15000);
      try {
        for await (const delta of gateway.streamText(
          connection,
          explanationPrompt(text),
          controller.signal,
        ))
          await send('delta', { text: delta });
        await send('done', {});
      } catch (error) {
        if (!controller.signal.aborted)
          await send('error', {
            error:
              error instanceof ApiError
                ? error.message
                : '解释暂时失败，请稍后重试',
          }).catch(() => {});
      } finally {
        clearInterval(heartbeat);
        reply.raw.removeListener('close', close);
        if (!reply.raw.destroyed) reply.raw.end();
      }
    },
  );
}
