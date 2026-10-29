import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pg, createPool, loadEnvironment } from '@dayzero/db';
import { ModelProfiles } from '../apps/server/src/model-profiles.ts';
import { createIngestionRuntime } from '../apps/server/src/ingestion-runtime.ts';
import { createTestDatabase } from './test-database.ts';
import type { DraftContent } from '@dayzero/contracts';
loadEnvironment();
const chatId = process.env.M2_CHAT_PROFILE_ID,
  embeddingId = process.env.M2_EMBEDDING_PROFILE_ID;
if (!chatId || !embeddingId)
  throw new Error(
    'Set M2_CHAT_PROFILE_ID and M2_EMBEDDING_PROFILE_ID to saved model profile IDs. This command makes real model calls.',
  );
const source = createPool();
const sourceModels = new ModelProfiles(source);
try {
  const chat = await sourceModels.connection(chatId, 'chat'),
    embedding = await sourceModels.connection(embeddingId, 'embedding');
  const database = await createTestDatabase('liveeval');
  const pool = new pg.Pool({ connectionString: database.url, max: 10 });
  const key = randomBytes(32).toString('base64'),
    runtime = createIngestionRuntime(pool, key);
  try {
    const profileIds = { chat: randomUUID(), embedding: randomUUID() };
    for (const config of [chat, embedding])
      await runtime.service.models.save(profileIds[config.purpose], {
        name: 'Isolated evaluation',
        purpose: config.purpose,
        baseUrl: config.baseUrl,
        modelId: config.modelId,
        apiKey: config.apiKey,
      });
    const corpus = JSON.parse(
      await readFile('tests/fixtures/knowledge-seed.json', 'utf8'),
    ) as { nodes: { id: string; title: string; markdown: string }[] };
    const labels = JSON.parse(
      await readFile('tests/fixtures/m2-evaluation.json', 'utf8'),
    ) as {
      labelStatus: string;
      cases: { id: string; query: string; expected: string[] }[];
    };
    const createDraft = async (title: string, markdown: string) =>
      runtime.service.knowledge.createDraft(randomUUID(), {
        title,
        markdown,
        aliases: [],
        tags: [],
        sources: [],
        links: [],
      } as DraftContent);
    const identities = new Map<string, string>();
    for (const input of corpus.nodes) {
      const draft = await createDraft(input.title, input.markdown);
      const saved = await runtime.service.knowledge.commitDraft(draft.id, {
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        confirmed: true,
      });
      identities.set(input.id, saved.node.id);
    }
    const measurements = [];
    for (const item of labels.cases) {
      const started = Date.now(),
        draft = await createDraft(item.query, item.query);
      const run = await runtime.service.start(draft.id, {
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        chatProfileId: profileIds.chat,
        embeddingProfileId: profileIds.embedding,
      });
      await runtime.process(run.id);
      const result = await runtime.service.get(run.id);
      const expected = item.expected.map((id) => identities.get(id));
      const found = expected.filter((id) =>
        result.candidates?.some((c) => c.targetId === id),
      ).length;
      measurements.push({
        id: item.id,
        query: item.query,
        expected: item.expected,
        status: result.status,
        error: result.error,
        recall: expected.length ? found / expected.length : null,
        noMatch: !expected.length ? result.candidates?.length === 0 : null,
        durationMs: Date.now() - started,
        candidates: result.candidates,
        proposals: result.proposals,
        calls: result.calls,
      });
      console.log(`${item.id}: ${result.status}`);
      await runtime.service.cancel(run.id);
    }
    const positives = measurements.filter((m) => m.recall !== null);
    const report = {
      status: 'measured',
      checkedAt: new Date().toISOString(),
      mode: 'live saved-model services; isolated knowledge database',
      models: { chat: chat.modelId, embedding: embedding.modelId },
      labels: labels.labelStatus,
      recallAt10:
        positives.reduce((n, m) => n + m.recall!, 0) / positives.length,
      completed: measurements.filter((m) => m.status === 'review').length,
      cases: measurements.length,
      acceptanceRate: null,
      note: 'Recall target 0.8; labels and proposal type/direction need user review. No automatic acceptance metric.',
      measurements,
    };
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/m2-live-evaluation.json',
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({ ...report, measurements: undefined }, null, 2),
    );
  } finally {
    await pool.end();
    await database.destroy();
  }
} finally {
  await source.end();
}
