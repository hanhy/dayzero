import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import type { HTTPMethods } from 'fastify';
import { pg } from '@dayzero/db';
import type {
  IngestionRun,
  KnowledgeDraft,
  KnowledgeNode,
  Library,
} from '@dayzero/contracts';
import { createApp } from '../apps/server/src/app.ts';
import { createIngestionRuntime } from '../apps/server/src/ingestion-runtime.ts';
import { createTestDatabase } from './test-database.ts';
let mode = 'ok',
  embeddingCalls = 0,
  rateAttempts = 0;
const mock = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  if (mode === 'rate' && rateAttempts++ < 2) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'isolated-test-only' }));
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/embeddings') {
    embeddingCalls++;
    res.end(
      JSON.stringify({
        data: input.input.map((text: string, index: number) => ({
          index,
          embedding:
            mode === 'dimensions' && embeddingCalls > 1
              ? [1, 0, 0, 0]
              : [
                  text.includes('梯度') ? 1 : 0.2,
                  text.includes('概率') ? 1 : 0.1,
                  0.4,
                ],
        })),
        usage: { prompt_tokens: 12, total_tokens: 12 },
      }),
    );
    return;
  }
  if (mode === 'slow') await delay(1200);
  const system = input.messages[0].content;
  const source = input.messages[1]
    ? JSON.parse(input.messages[1].content)
    : null;
  let output: unknown;
  if (!source) {
    res.end(
      JSON.stringify({ choices: [{ message: { content: '连接成功' } }] }),
    );
    return;
  }
  if (system.includes('"coreConcept"'))
    output = {
      coreConcept: source.title,
      summary: '梯度描述函数变化最快的方向，可用于指导参数更新。',
    };
  else
    output = {
      matches: source.candidates.map((c: any) => ({
        targetId: c.targetId,
        level: 'high',
        reason: '已有片段提供背景',
        duplicate: mode === 'duplicate',
      })),
      proposals: source.candidates.slice(0, 1).map((c: any) => ({
        targetId: mode === 'endpoint' ? randomUUID() : c.targetId,
        type: 'used_for',
        direction: 'outgoing',
        description: '用于参数更新',
        draftQuote:
          mode === 'citation'
            ? '凭空捏造的引用'
            : source.draft.markdown.slice(0, 12),
        targetQuote: c.excerpt.slice(0, 12),
        confidence: 'supported',
      })),
    };
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: mode === 'json' ? 'invalid-json' : JSON.stringify(output),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }),
  );
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address() as { port: number };
const database = await createTestDatabase('m2');
const pool = new pg.Pool({ connectionString: database.url, max: 10 });
const masterKey = randomBytes(32).toString('base64');
const app = createApp(pool, { logging: false, masterKey });
const runtime = createIngestionRuntime(pool, masterKey),
  checks: string[] = [];
let worker: ReturnType<typeof spawn> | undefined;
const op = () => ({ operationId: randomUUID() });
async function call<T>(
  method: HTTPMethods,
  url: string,
  body?: object,
  status = 200,
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    ...(body ? { payload: body } : {}),
  });
  assert.equal(
    response.statusCode,
    status,
    `${method} ${url}: ${response.body}`,
  );
  return response.json();
}
const library = () => call<Library>('GET', '/api/knowledge');
async function draft(title: string) {
  const created = await call<KnowledgeDraft>('POST', '/api/drafts', op());
  return call<KnowledgeDraft>('PUT', `/api/drafts/${created.id}`, {
    ...op(),
    expectedRevision: created.revision,
    title,
    markdown: `# ${title}\n\n梯度知识用于更新模型参数。`,
    aliases: [],
    tags: [],
    sources: [],
    links: [],
  });
}
const chat = randomUUID(),
  embedding = randomUUID();
async function start(value: KnowledgeDraft) {
  return call<IngestionRun>('POST', `/api/drafts/${value.id}/analyze`, {
    ...op(),
    expectedRevision: value.revision,
    chatProfileId: chat,
    embeddingProfileId: embedding,
  });
}
async function get(id: string) {
  return call<IngestionRun>('GET', `/api/ingestion/${id}`);
}
async function review(run: IngestionRun, accept = true) {
  return call<IngestionRun>('PUT', `/api/ingestion/${run.id}/review`, {
    ...op(),
    expectedReviewVersion: run.reviewVersion,
    links: accept
      ? (run.proposals ?? []).map((p) => ({
          targetId: p.targetId,
          type: p.type,
          direction: p.direction,
          description: p.description,
          targetRevision: run.candidates!.find(
            (c) => c.targetId === p.targetId,
          )!.revision,
        }))
      : [],
    decisions: (run.proposals ?? []).map((p) => ({
      proposalId: p.id,
      accepted: accept,
    })),
    independent: !accept,
  });
}
async function analyze(title: string) {
  const d = await draft(title),
    run = await start(d);
  await runtime.process(run.id);
  return { draft: d, run: await get(run.id) };
}
try {
  for (const [id, purpose] of [
    [chat, 'chat'],
    [embedding, 'embedding'],
  ] as const)
    await call('PUT', `/api/models/${id}`, {
      name: `测试${purpose}`,
      purpose,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: purpose,
      apiKey: 'isolated-test-only',
    });
  assert.equal(
    (await call<{ ok: boolean }>('POST', `/api/models/${chat}/test`, {})).ok,
    true,
  );
  assert.equal(
    (
      await call<{ dimensions: number }>(
        'POST',
        `/api/models/${embedding}/test`,
        {},
      )
    ).dimensions,
    3,
  );
  checks.push('independent-real-http-connection-tests');
  const empty = await analyze('空库概念');
  assert.equal(empty.run.status, 'review');
  assert.deepEqual(empty.run.candidates, []);
  assert.equal((await library()).nodes.length, 0);
  const emptyDecision = await review(empty.run, false);
  await call(
    'POST',
    `/api/ingestion/${empty.run.id}/confirm`,
    { expectedReviewVersion: emptyDecision.reviewVersion, confirmed: false },
    400,
  );
  await call('POST', `/api/ingestion/${empty.run.id}/cancel`, {});
  checks.push(
    'empty-library-no-write-before-confirm',
    'explicit-confirmation-required',
  );
  const aDraft = await draft('梯度下降');
  const a = (
    await call<{ node: KnowledgeNode }>(
      'POST',
      `/api/drafts/${aDraft.id}/commit`,
      { ...op(), expectedRevision: aDraft.revision, confirmed: true },
    )
  ).node;
  const normal = await analyze('反向传播');
  assert.equal(normal.run.status, 'review');
  assert.equal(normal.run.proposals?.length, 1);
  assert.ok(normal.run.candidates?.some((c) => c.targetId === a.id));
  const saved = await review(normal.run);
  assert.equal(saved.reviewVersion, 1);
  // A fresh runtime reads the persisted interruption without invoking models again.
  const callsBefore = await pool.query(
    'SELECT count(*) FROM knowledge.model_calls WHERE run_id=$1',
    [normal.run.id],
  );
  const reread = await createIngestionRuntime(pool, masterKey).service.get(
    normal.run.id,
  );
  assert.deepEqual(reread.decision, saved.decision);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM knowledge.model_calls WHERE run_id=$1',
        [normal.run.id],
      )
    ).rows[0].count,
    callsBefore.rows[0].count,
  );
  checks.push(
    'hybrid-candidates-with-evidence',
    'review-decision-persisted',
    'waiting-does-not-call-model',
  );
  await call('POST', `/api/ingestion/${normal.run.id}/confirm`, {
    expectedReviewVersion: saved.reviewVersion,
    confirmed: true,
  });
  await call('POST', `/api/ingestion/${normal.run.id}/confirm`, {
    expectedReviewVersion: saved.reviewVersion,
    confirmed: true,
  });
  // Use the real pg-boss worker in a separate process to resume and commit.
  worker = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/worker/src/index.ts'],
    {
      env: {
        ...process.env,
        DATABASE_URL: database.url,
        MODEL_MASTER_KEY: masterKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  worker.stdout!.resume();
  worker.stderr!.resume();
  for (let i = 0; i < 100; i++) {
    if ((await get(normal.run.id)).status === 'committed') break;
    await delay(200);
  }
  const committed = await get(normal.run.id);
  assert.equal(committed.status, 'committed');
  assert.equal((await library()).nodes.length, 2);
  assert.equal((await library()).relations.length, 1);
  const commitOp = (
    await pool.query(
      'SELECT commit_operation_id FROM knowledge.ingestion_runs WHERE id=$1',
      [normal.run.id],
    )
  ).rows[0].commit_operation_id;
  const replay = await runtime.service.knowledge.commitDraft(
    normal.draft.id,
    {
      operationId: commitOp,
      expectedRevision: normal.draft.revision,
      confirmed: true,
    },
    { runId: normal.run.id, decisionId: saved.decision!.id },
  );
  assert.equal(replay.node.id, committed.resultNodeId);
  assert.equal((await library()).nodes.length, 2);
  checks.push(
    'cross-process-langgraph-resume',
    'real-pg-boss-ingestion',
    'commit-replay-idempotent',
    'confirm-retry-idempotent',
  );
  worker.kill('SIGTERM');
  await new Promise<void>((resolve) => worker!.once('exit', () => resolve()));
  worker = undefined;
  mode = 'rate';
  rateAttempts = 0;
  const rate = await analyze('限流退避');
  assert.equal(rate.run.status, 'review');
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM knowledge.model_calls WHERE run_id=$1 AND status='retry'",
          [rate.run.id],
        )
      ).rows[0].count,
    ),
    2,
  );
  await call('POST', `/api/ingestion/${rate.run.id}/cancel`, {});
  mode = 'ok';
  checks.push('rate-limit-backoff-counts-real-attempts');
  const modified = await analyze('正文修改');
  const current = modified.draft;
  await call('PUT', `/api/drafts/${current.id}`, {
    ...op(),
    expectedRevision: current.revision,
    title: current.title,
    markdown: '修改后的全新内容',
    aliases: [],
    tags: [],
    sources: [],
    links: [],
  });
  assert.equal((await get(modified.run.id)).status, 'stale');
  await call(
    'PUT',
    `/api/ingestion/${modified.run.id}/review`,
    {
      ...op(),
      expectedReviewVersion: 0,
      links: [],
      decisions: [],
      independent: true,
    },
    409,
  );
  checks.push('draft-change-invalidates-analysis');
  const endpoint = await analyze('端点改变');
  const approved = await review(endpoint.run);
  const target = (await library()).nodes.find(
    (n) => n.id === approved.decision!.links[0]!.targetId,
  )!;
  await call('PUT', `/api/nodes/${target.id}`, {
    ...op(),
    expectedRevision: target.revision,
    title: `${target.title}改名`,
    markdown: target.markdown,
    aliases: target.aliases,
    tags: target.tags,
    sources: target.sources,
  });
  await call(
    'POST',
    `/api/ingestion/${endpoint.run.id}/confirm`,
    { expectedReviewVersion: approved.reviewVersion, confirmed: true },
    409,
  );
  await call('POST', `/api/ingestion/${endpoint.run.id}/cancel`, {});
  checks.push('endpoint-version-recheck');
  const deleted = await analyze('端点删除');
  const deletionReview = await review(deleted.run);
  const deleteTarget = (await library()).nodes.find(
    (n) => n.id === deletionReview.decision!.links[0]!.targetId,
  )!;
  await call('POST', `/api/nodes/${deleteTarget.id}/delete`, {
    ...op(),
    expectedRevision: deleteTarget.revision,
  });
  await call(
    'POST',
    `/api/ingestion/${deleted.run.id}/confirm`,
    { expectedReviewVersion: deletionReview.reviewVersion, confirmed: true },
    409,
  );
  const trashed = (await library()).nodes.find(
    (n) => n.id === deleteTarget.id,
  )!;
  await call('POST', `/api/nodes/${deleteTarget.id}/restore`, {
    ...op(),
    expectedRevision: trashed.revision,
  });
  await call('POST', `/api/ingestion/${deleted.run.id}/cancel`, {});
  checks.push('deleted-endpoint-cannot-commit');
  mode = 'duplicate';
  const duplicate = await analyze('疑似重复');
  const duplicateReview = await review(duplicate.run);
  await call(
    'POST',
    `/api/ingestion/${duplicate.run.id}/confirm`,
    { expectedReviewVersion: duplicateReview.reviewVersion, confirmed: true },
    400,
  );
  await call('POST', `/api/ingestion/${duplicate.run.id}/cancel`, {});
  checks.push('duplicate-needs-explicit-independent-decision');
  mode = 'json';
  const failure = await analyze('失败重试');
  assert.equal(failure.run.status, 'failed');
  mode = 'ok';
  await call('POST', `/api/ingestion/${failure.run.id}/retry`, {});
  await runtime.process(failure.run.id);
  assert.equal((await get(failure.run.id)).status, 'review');
  await call('POST', `/api/ingestion/${failure.run.id}/cancel`, {});
  checks.push('invalid-json-bounded-retry', 'failed-checkpoint-resumes');
  for (const bad of ['citation', 'endpoint']) {
    mode = bad;
    const invalid = await analyze(`非法${bad}`);
    assert.equal(invalid.run.status, 'failed');
  }
  mode = 'dimensions';
  embeddingCalls = 0;
  await pool.query('DELETE FROM knowledge.node_chunks');
  const dimensions = await analyze('维度错误');
  assert.equal(dimensions.run.status, 'failed');
  mode = 'ok';
  checks.push(
    'fabricated-evidence-rejected',
    'invented-endpoint-rejected',
    'dimension-mismatch-rejected',
  );
  const allRejected = await analyze('全部拒绝');
  const rejected = await review(allRejected.run, false);
  await call('POST', `/api/ingestion/${allRejected.run.id}/confirm`, {
    expectedReviewVersion: rejected.reviewVersion,
    confirmed: true,
  });
  await runtime.process(allRejected.run.id);
  assert.equal((await get(allRejected.run.id)).status, 'committed');
  assert.equal((await library()).relations.length, 1);
  checks.push('all-rejected-independent-commit');
  mode = 'slow';
  const cancellation = await start(await draft('取消进行中'));
  const processing = runtime.process(cancellation.id);
  await delay(100);
  await call('POST', `/api/ingestion/${cancellation.id}/cancel`, {});
  await processing;
  assert.equal((await get(cancellation.id)).status, 'cancelled');
  mode = 'ok';
  checks.push('in-flight-cancellation-no-commit');
  assert.equal((await library()).nodes.length, 3);
  const confirmations = (
    await pool.query(
      'SELECT decision FROM knowledge.confirmations WHERE entity_id=$1',
      [committed.resultNodeId],
    )
  ).rows[0].decision;
  assert.equal(confirmations.runId, normal.run.id);
  assert.ok(confirmations.analysis.proposals.length > 0);
  assert.equal(confirmations.decision.id, saved.decision!.id);
  checks.push('confirmation-keeps-run-and-review-provenance');
  const report = {
    status: 'passed',
    checkedAt: new Date().toISOString(),
    model: 'isolated HTTP fixture; not a real model quality evaluation',
    checks,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/m2-integration.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (worker) {
    worker.kill('SIGKILL');
  }
  await app.close();
  await pool.end();
  await database.destroy();
  mock.closeAllConnections();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
}
