import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Command } from '@langchain/langgraph';
import { createIngestionGraph } from '@dayzero/workflows';
import type { Pool } from 'pg';
import { ApiError } from './knowledge-service.ts';
import { IngestionService } from './ingestion-service.ts';

export function createIngestionRuntime(pool: Pool, masterKey?: string) {
  const service = new IngestionService(pool, masterKey);
  const saver = new PostgresSaver(pool);
  return {
    service,
    async process(runId: string) {
      const lock = await pool.connect();
      const acquired = await lock.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1,725003)) AS locked',
        [runId],
      );
      if (!acquired.rows[0].locked) {
        lock.release();
        return;
      }
      const controller = new AbortController();
      let monitoring = false;
      const monitor = setInterval(() => {
        if (monitoring) return;
        monitoring = true;
        void service
          .get(runId)
          .then((run) => {
            if (['cancelled', 'stale'].includes(run.status)) controller.abort();
          })
          .catch(() => {})
          .finally(() => {
            monitoring = false;
          });
      }, 500);
      try {
        let run = await service.raw(runId);
        if (!['queued', 'processing', 'committing'].includes(run.status))
          return;
        const graph = createIngestionGraph(saver, {
          parse: (id) => service.parse(id, controller.signal),
          match: (id) => service.match(id, controller.signal),
          suggest: (id) => service.suggest(id, controller.signal),
          commit: async (id, decisionId) => {
            const current = await service.raw(id);
            if (current.status === 'committed' && current.resultNodeId)
              return current.resultNodeId;
            const { run: valid } = await service.guard(id);
            if (valid.decision?.id !== decisionId)
              throw new ApiError(409, '人工确认版本已改变');
            await pool.query(
              "UPDATE knowledge.ingestion_runs SET status='committing',stage='commit',updated_at=now() WHERE id=$1 AND status NOT IN ('cancelled','stale','committed')",
              [id],
            );
            const commit = await pool.query(
              'SELECT commit_operation_id FROM knowledge.ingestion_runs WHERE id=$1',
              [id],
            );
            const result = await service.knowledge.commitDraft(
              valid.draftId,
              {
                operationId: commit.rows[0].commit_operation_id,
                expectedRevision: valid.draftRevision,
                confirmed: true,
              },
              { runId: id, decisionId },
            );
            return result.node.id;
          },
        });
        const config = { configurable: { thread_id: runId } };
        const state = await graph.getState(config);
        if (!state.values?.runId) await graph.invoke({ runId }, config);
        else if (
          state.tasks?.some((task) => task.interrupts?.length) &&
          run.decision &&
          run.stage === 'commit'
        )
          await graph.invoke(
            new Command({ resume: { decisionId: run.decision.id } }),
            config,
          );
        else await graph.invoke(null, config);
        run = await service.raw(runId);
        if (run.status !== 'committed') {
          await service.guard(runId);
          await pool.query(
            "UPDATE knowledge.ingestion_runs SET status='review',stage='review',error=NULL,updated_at=now() WHERE id=$1 AND status NOT IN ('cancelled','stale','committed')",
            [runId],
          );
        }
      } catch (error) {
        const current = await service.raw(runId);
        if (!['committed', 'cancelled', 'stale'].includes(current.status)) {
          const stale = error instanceof ApiError && error.statusCode === 409;
          await pool.query(
            "UPDATE knowledge.ingestion_runs SET status=$2,error=$3,updated_at=now() WHERE id=$1 AND status NOT IN ('committed','cancelled','stale')",
            [
              runId,
              stale ? 'stale' : 'failed',
              error instanceof ApiError
                ? error.message
                : '分析暂时失败，请检查模型配置后重试',
            ],
          );
        }
      } finally {
        clearInterval(monitor);
        await lock.query(
          'SELECT pg_advisory_unlock(hashtextextended($1,725003))',
          [runId],
        );
        lock.release();
      }
    },
  };
}
