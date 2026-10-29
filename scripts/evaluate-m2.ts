import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { lexicalScore } from '../apps/server/src/retrieval.ts';
const corpus = JSON.parse(
  await readFile('tests/fixtures/knowledge-seed.json', 'utf8'),
) as { nodes: { id: string; title: string; markdown: string }[] };
const dataset = JSON.parse(
  await readFile('tests/fixtures/m2-evaluation.json', 'utf8'),
) as {
  labelStatus: string;
  cases: { id: string; category: string; query: string; expected: string[] }[];
};
const measurements = dataset.cases.map((example) => {
  const started = performance.now();
  const results = corpus.nodes
    .map((node) => ({
      id: node.id,
      score: lexicalScore(example.query, `${node.title}\n${node.markdown}`),
    }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const found = example.expected.filter((id) =>
    results.some((r) => r.id === id),
  ).length;
  return {
    ...example,
    retrieved: results.map((n) => n.id),
    recall: example.expected.length ? found / example.expected.length : null,
    noMatchCorrect: !example.expected.length ? results.length === 0 : null,
    durationMs: Number((performance.now() - started).toFixed(3)),
  };
});
const positives = measurements.filter((m) => m.recall !== null),
  negatives = measurements.filter((m) => m.noMatchCorrect !== null);
const report = {
  status: 'measured',
  checkedAt: new Date().toISOString(),
  mode: 'keyword-only development baseline; no model called',
  labels: dataset.labelStatus,
  cases: measurements.length,
  corpus: corpus.nodes.length,
  recallAt10: positives.reduce((n, m) => n + m.recall!, 0) / positives.length,
  noMatchAccuracy:
    negatives.filter((m) => m.noMatchCorrect).length / negatives.length,
  latencyMeanMs:
    measurements.reduce((n, m) => n + m.durationMs, 0) / measurements.length,
  modelSuggestionAcceptance: null,
  realModelQuality: 'pending model configuration and user-reviewed labels',
  measurements,
};
await mkdir('artifacts', { recursive: true });
await writeFile(
  'artifacts/m2-evaluation.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, measurements: undefined }, null, 2));
