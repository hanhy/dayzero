import {
  Annotation,
  StateGraph,
  START,
  END,
  interrupt,
} from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
const State = Annotation.Root({
  runId: Annotation<string>,
  decisionId: Annotation<string>,
  nodeId: Annotation<string>,
});
export function createIngestionGraph(
  saver: PostgresSaver,
  hooks: {
    parse: (id: string) => Promise<void>;
    match: (id: string) => Promise<void>;
    suggest: (id: string) => Promise<void>;
    commit: (id: string, decisionId: string) => Promise<string>;
  },
) {
  return new StateGraph(State)
    .addNode('parse', async (s) => {
      await hooks.parse(s.runId);
      return {};
    })
    .addNode('match', async (s) => {
      await hooks.match(s.runId);
      return {};
    })
    .addNode('suggest', async (s) => {
      await hooks.suggest(s.runId);
      return {};
    })
    .addNode('review', () => {
      const decision = interrupt<{ kind: string }, { decisionId: string }>({
        kind: 'knowledge-review',
      });
      return { decisionId: decision.decisionId };
    })
    .addNode('commit', async (s) => ({
      nodeId: await hooks.commit(s.runId, s.decisionId),
    }))
    .addEdge(START, 'parse')
    .addEdge('parse', 'match')
    .addEdge('match', 'suggest')
    .addEdge('suggest', 'review')
    .addEdge('review', 'commit')
    .addEdge('commit', END)
    .compile({ checkpointer: saver });
}
