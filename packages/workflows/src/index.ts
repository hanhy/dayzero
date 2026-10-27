import { randomUUID } from 'node:crypto';
import {
  Annotation,
  StateGraph,
  START,
  END,
  interrupt,
} from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { type pg } from '@dayzero/db';

export const ProofState = Annotation.Root({
  operationId: Annotation<string>,
  title: Annotation<string>,
  parsed: Annotation<string>,
  approved: Annotation<boolean>,
  nodeId: Annotation<string>,
});

// This proof has its own schema and does not write real knowledge nodes.
export async function commitProof(
  pool: pg.Pool,
  operationId: string,
  title: string,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO m0.workflow_commits(operation_id, node_id, title, decision)
       VALUES ($1, $2, $3, '{"approved":true}'::jsonb)
       ON CONFLICT (operation_id) DO NOTHING`,
      [operationId, randomUUID(), title],
    );
    const result = await client.query<{ node_id: string; title: string }>(
      'SELECT node_id, title FROM m0.workflow_commits WHERE operation_id = $1',
      [operationId],
    );
    const row = result.rows[0];
    if (!row || row.title !== title)
      throw new Error('Operation ID reused with different content');
    await client.query(
      `INSERT INTO m0.outbox(operation_id, payload) VALUES ($1, $2)
       ON CONFLICT (operation_id) DO NOTHING`,
      [
        operationId,
        JSON.stringify({ nodeId: row.node_id, kind: 'proof.committed' }),
      ],
    );
    await client.query('COMMIT');
    return row.node_id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createProofGraph(
  saver: PostgresSaver,
  pool: pg.Pool,
  crashAfterCommit = false,
) {
  return new StateGraph(ProofState)
    .addNode('parse', (state) => ({ parsed: state.title.trim() }))
    .addNode('review', () => {
      const decision: unknown = interrupt({
        kind: 'm0-review',
        message: '确认保存这条隔离验证记录？',
      });
      if (
        typeof decision !== 'object' ||
        decision === null ||
        !('approved' in decision) ||
        typeof decision.approved !== 'boolean'
      )
        throw new Error('Approval must contain an approved boolean');
      return { approved: decision.approved };
    })
    .addNode('commit', async (state) => {
      if (!state.approved) return {};
      const nodeId = await commitProof(pool, state.operationId, state.parsed);
      // Simulate a crash after the DB transaction but before LangGraph checkpoints this node.
      if (crashAfterCommit) process.exit(86);
      return { nodeId };
    })
    .addEdge(START, 'parse')
    .addEdge('parse', 'review')
    .addEdge('review', 'commit')
    .addEdge('commit', END)
    .compile({ checkpointer: saver });
}
