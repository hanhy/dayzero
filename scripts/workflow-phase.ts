import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createPool, databaseUrl, loadEnvironment } from '@dayzero/db';
import { createProofGraph } from '@dayzero/workflows';

loadEnvironment();
const [phase, threadId] = process.argv.slice(2);
if (!threadId || !['start', 'crash', 'recover', 'reject'].includes(phase ?? ''))
  throw new Error('Invalid proof phase');
const pool = createPool();
const saver = PostgresSaver.fromConnString(databaseUrl());
try {
  const graph = createProofGraph(saver, pool, phase === 'crash');
  const config = { configurable: { thread_id: threadId } };
  const result =
    phase === 'start'
      ? await graph.invoke(
          { operationId: threadId, title: '  M0 · 人工确认验证  ' },
          config,
        )
      : phase === 'crash' || phase === 'reject'
        ? await graph.invoke(
            new Command({ resume: { approved: phase === 'crash' } }),
            config,
          )
        : await graph.invoke(null, config);
  const state = await graph.getState(config);
  console.log(
    JSON.stringify({
      phase,
      pid: process.pid,
      waiting: state.tasks.some((task) => (task.interrupts?.length ?? 0) > 0),
      nodeId: result.nodeId ?? null,
      pending: state.next,
    }),
  );
} finally {
  await saver.end();
  await pool.end();
}
