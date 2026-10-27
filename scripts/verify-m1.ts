import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { HTTPMethods } from 'fastify';
import type {
  KnowledgeBackup,
  KnowledgeDraft,
  KnowledgeNode,
  KnowledgeRelation,
  Library,
  ModelProfile,
  NodeHistory,
} from '@dayzero/contracts';
import { pg } from '@dayzero/db';
import { createApp } from '../apps/server/src/app.ts';
import { acknowledgeEvent } from '../apps/worker/src/outbox.ts';
import { createTestDatabase } from './test-database.ts';

const source = await createTestDatabase('m1'),
  target = await createTestDatabase('restore');
const pool = new pg.Pool({ connectionString: source.url }),
  restoredPool = new pg.Pool({ connectionString: target.url });
const app = createApp(pool, {
  masterKey: randomBytes(32).toString('base64'),
  logging: false,
});
const restoredApp = createApp(restoredPool, { logging: false });
const checks: string[] = [],
  op = () => ({ operationId: randomUUID() });
async function call<T>(
  method: HTTPMethods,
  url: string,
  body?: unknown,
  status = 200,
  server = app,
): Promise<T> {
  const response = await server.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  assert.equal(
    response.statusCode,
    status,
    `${method} ${url}: ${response.body}`,
  );
  return response.json() as T;
}
async function draft(title: string, links: KnowledgeDraft['links'] = []) {
  const value = await call<KnowledgeDraft>('POST', '/api/drafts', op());
  return call<KnowledgeDraft>('PUT', `/api/drafts/${value.id}`, {
    ...op(),
    expectedRevision: value.revision,
    title,
    markdown: `# ${title}\n\n人工整理的知识。`,
    aliases: ['别名测试'],
    tags: ['测试'],
    sources: ['个人笔记'],
    links,
  });
}
const library = (server = app) =>
  call<Library>('GET', '/api/knowledge', undefined, 200, server);
const node = async (id: string) =>
  (await library()).nodes.find((n) => n.id === id)!;
try {
  assert.equal(
    (await call<{ milestone: string }>('GET', '/api/health')).milestone,
    'M1',
  );
  const aDraft = await draft('梯度下降');
  assert.equal((await library()).nodes.length, 0);
  await call(
    'PUT',
    `/api/drafts/${aDraft.id}`,
    {
      ...op(),
      expectedRevision: 1,
      title: '覆盖',
      markdown: '',
      aliases: [],
      tags: [],
      sources: [],
      links: [],
    },
    409,
  );
  await call(
    'POST',
    `/api/drafts/${aDraft.id}/commit`,
    { ...op(), expectedRevision: aDraft.revision, confirmed: false },
    400,
  );
  const confirmation = {
    ...op(),
    expectedRevision: aDraft.revision,
    confirmed: true,
  };
  const commits = await Promise.all(
    Array.from({ length: 8 }, () =>
      call<{ node: KnowledgeNode }>(
        'POST',
        `/api/drafts/${aDraft.id}/commit`,
        confirmation,
      ),
    ),
  );
  const a = commits[0]!.node;
  assert.ok(commits.every((value) => value.node.id === a.id));
  assert.equal((await library()).nodes.length, 1);
  checks.push(
    'draft-persistence',
    'explicit-confirmation-required',
    'concurrent-idempotent-commit',
    'optimistic-conflict',
  );
  const bDraft = await draft('反向传播', [
    {
      targetId: a.id,
      type: 'used_for',
      direction: 'outgoing',
      description: '提供优化所需的梯度',
    },
  ]);
  const bCommit = await call<{
    node: KnowledgeNode;
    relations: KnowledgeRelation[];
  }>('POST', `/api/drafts/${bDraft.id}/commit`, {
    ...op(),
    expectedRevision: bDraft.revision,
    confirmed: true,
  });
  const b = bCommit.node,
    directed = bCommit.relations[0]!;
  assert.equal(directed.sourceId, b.id);
  assert.equal(directed.targetId, a.id);
  const symmetric = await call<KnowledgeRelation>('POST', '/api/relations', {
    ...op(),
    sourceId: a.id,
    targetId: b.id,
    type: 'related',
    description: '同一优化流程',
    confirmed: true,
  });
  assert.ok(symmetric.sourceId < symmetric.targetId);
  await call(
    'POST',
    '/api/relations',
    {
      ...op(),
      sourceId: b.id,
      targetId: a.id,
      type: 'related',
      description: '',
      confirmed: true,
    },
    409,
  );
  await call(
    'POST',
    '/api/relations',
    {
      ...op(),
      sourceId: a.id,
      targetId: a.id,
      type: 'related',
      description: '',
      confirmed: true,
    },
    400,
  );
  await call('PUT', `/api/relations/${directed.id}`, {
    ...op(),
    expectedRevision: directed.revision,
    sourceId: b.id,
    targetId: a.id,
    type: 'prerequisite',
    description: '方向验证',
    confirmed: true,
  });
  await call(
    'POST',
    '/api/relations',
    {
      ...op(),
      sourceId: a.id,
      targetId: b.id,
      type: 'prerequisite',
      description: '',
      confirmed: true,
    },
    409,
  );
  checks.push(
    'direction-preserved',
    'symmetric-normalization',
    'duplicate-and-self-edge-rejected',
    'prerequisite-cycle-rejected',
  );
  const edited = await call<KnowledgeNode>('PUT', `/api/nodes/${a.id}`, {
    ...op(),
    expectedRevision: a.revision,
    title: '梯度下降方法',
    markdown: '# 新正文\n\n保留知识关联。',
    aliases: ['GD', '梯度法'],
    tags: ['优化'],
    sources: ['原始笔记'],
  });
  assert.equal(edited.id, a.id);
  assert.equal(
    (await library()).relations.filter((r) => !r.deletedAt).length,
    2,
  );
  assert.ok(
    (await call<KnowledgeNode[]>('GET', '/api/knowledge/search?q=梯度法')).some(
      (n) => n.id === a.id,
    ),
  );
  assert.equal(
    (await call<NodeHistory>('GET', `/api/nodes/${a.id}/history`)).revisions
      .length,
    2,
  );
  const reverted = await call<KnowledgeNode>(
    'POST',
    `/api/nodes/${a.id}/restore-version`,
    { ...op(), expectedRevision: edited.revision, version: 1 },
  );
  assert.equal(reverted.revision, 3);
  assert.equal(reverted.title, a.title);
  checks.push(
    'rename-retains-relations',
    'chinese-alias-search',
    'version-restore-creates-new-revision',
  );
  await call('POST', `/api/relations/${symmetric.id}/delete`, {
    ...op(),
    expectedRevision: symmetric.revision,
  });
  await call('POST', `/api/nodes/${a.id}/delete`, {
    ...op(),
    expectedRevision: reverted.revision,
  });
  assert.equal(
    (await library()).relations.filter((r) => !r.deletedAt).length,
    0,
  );
  const recovered = await call<{ restoredRelations: number }>(
    'POST',
    `/api/nodes/${a.id}/restore`,
    { ...op(), expectedRevision: (await node(a.id)).revision },
  );
  assert.equal(recovered.restoredRelations, 1);
  assert.ok(
    (await library()).relations.find((r) => r.id === symmetric.id)!.deletedAt,
  );
  for (const id of [b.id, a.id])
    await call('POST', `/api/nodes/${id}/delete`, {
      ...op(),
      expectedRevision: (await node(id)).revision,
    });
  for (const id of [b.id, a.id])
    await call('POST', `/api/nodes/${id}/restore`, {
      ...op(),
      expectedRevision: (await node(id)).revision,
    });
  assert.equal(
    (await library()).relations.filter((r) => !r.deletedAt).length,
    1,
  );
  checks.push(
    'soft-delete-hides-edges',
    'manual-deletion-not-auto-restored',
    'endpoint-restore-order-independent',
  );
  const exported = await app.inject(`/api/nodes/${a.id}/markdown`);
  assert.equal(exported.statusCode, 200);
  const imported = await call<KnowledgeDraft>('POST', '/api/import/markdown', {
    ...op(),
    filename: '笔记.md',
    text: exported.body,
  });
  assert.notEqual(imported.id, a.id);
  assert.equal(imported.title, a.title);
  assert.equal(imported.markdown, a.markdown);
  assert.deepEqual(imported.aliases, a.aliases);
  assert.equal((await library()).nodes.length, 2);
  checks.push('markdown-roundtrip-is-draft');
  const invalidDraft = await draft('事务回滚验证', [
    {
      targetId: randomUUID(),
      type: 'related',
      direction: 'outgoing',
      description: '',
    },
  ]);
  const beforeFailure = await call<KnowledgeBackup>('GET', '/api/backups');
  await call(
    'POST',
    `/api/drafts/${invalidDraft.id}/commit`,
    {
      ...op(),
      expectedRevision: invalidDraft.revision,
      confirmed: true,
    },
    404,
  );
  const afterFailure = await call<KnowledgeBackup>('GET', '/api/backups');
  for (const key of [
    'nodes',
    'drafts',
    'relations',
    'revisions',
    'confirmations',
    'events',
  ] as const)
    assert.deepEqual(afterFailure[key], beforeFailure[key]);
  checks.push('failed-link-rolls-back-entire-commit');
  // Fresh application processes read the same persisted library after exiting.
  const persistedLibrary = await library();
  for (let restart = 0; restart < 2; restart++) {
    const processRead = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { createApp } from './apps/server/src/app.ts';
      import { pg } from '@dayzero/db';
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const app = createApp(pool, { logging: false });
      const response = await app.inject('/api/knowledge');
      if (response.statusCode !== 200) throw new Error('Read failed');
      console.log(response.body);
      await app.close(); await pool.end();
    `,
      ],
      {
        env: { ...process.env, DATABASE_URL: source.url },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(processRead.status, 0, processRead.stderr);
    assert.deepEqual(JSON.parse(processRead.stdout), persistedLibrary);
  }
  checks.push('new-process-reads-persisted-library');
  const secret = `m1-test-only-${randomUUID()}`,
    profileId = randomUUID();
  const profile = {
    name: '测试配置',
    purpose: 'chat',
    baseUrl: 'https://example.invalid/v1',
    modelId: 'test-model',
    apiKey: secret,
  };
  const saved = await call<ModelProfile>(
    'PUT',
    `/api/models/${profileId}`,
    profile,
  );
  assert.equal(saved.keyConfigured, true);
  assert.ok(!JSON.stringify(saved).includes(secret));
  const ciphertext = (
    await pool.query(
      'SELECT encrypted_key FROM knowledge.model_profiles WHERE id=$1',
      [profileId],
    )
  ).rows[0].encrypted_key as string;
  assert.ok(ciphertext.startsWith('v1:'));
  assert.ok(!ciphertext.includes(secret));
  await call('PUT', `/api/models/${profileId}`, {
    ...profile,
    apiKey: '',
    name: '修改名称',
  });
  assert.equal(
    (
      await pool.query(
        'SELECT encrypted_key FROM knowledge.model_profiles WHERE id=$1',
        [profileId],
      )
    ).rows[0].encrypted_key,
    ciphertext,
  );
  checks.push('key-encrypted-and-redacted', 'empty-key-preserves-secret');
  const backup = await call<KnowledgeBackup>('GET', '/api/backups');
  assert.ok(!JSON.stringify(backup).includes(secret));
  assert.ok(!JSON.stringify(backup).includes(ciphertext));
  await call(
    'POST',
    '/api/backups/restore',
    { ...op(), confirmed: true, backup },
    409,
  );
  const invalid = structuredClone(backup);
  invalid.relations[0]!.targetId = randomUUID();
  await call(
    'POST',
    '/api/backups/restore',
    { ...op(), confirmed: true, backup: invalid },
    400,
    restoredApp,
  );
  assert.equal((await library(restoredApp)).nodes.length, 0);
  const restoreBody = { ...op(), confirmed: true, backup };
  await call('POST', '/api/backups/restore', restoreBody, 200, restoredApp);
  await call('POST', '/api/backups/restore', restoreBody, 200, restoredApp);
  assert.deepEqual(await library(restoredApp), await library());
  const roundtrip = await call<KnowledgeBackup>(
    'GET',
    '/api/backups',
    undefined,
    200,
    restoredApp,
  );
  assert.deepEqual(roundtrip.revisions, backup.revisions);
  assert.deepEqual(roundtrip.confirmations, backup.confirmations);
  assert.deepEqual(roundtrip.events, backup.events);
  checks.push(
    'backup-has-no-secrets',
    'nonempty-restore-rejected',
    'invalid-restore-atomic',
    'full-restore-preserves-identities-and-history',
    'restore-idempotent',
  );
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/worker/src/index.ts'],
    {
      env: { ...process.env, DATABASE_URL: source.url },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  worker.stdout.resume();
  worker.stderr.on('data', (chunk) => {
    output += String(chunk).slice(0, 1000);
  });
  try {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM knowledge.outbox WHERE delivered_at IS NULL',
            )
          ).rows[0].count,
        ) === 0
      )
        break;
      if (worker.exitCode !== null) throw new Error(`Worker exited: ${output}`);
      await delay(250);
    }
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) FROM knowledge.outbox WHERE delivered_at IS NULL',
          )
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      await acknowledgeEvent(
        pool,
        (await pool.query('SELECT id FROM knowledge.outbox LIMIT 1')).rows[0]
          .id,
      ),
      false,
    );
    checks.push(
      'real-worker-delivers-outbox',
      'duplicate-delivery-one-receipt',
    );
  } finally {
    worker.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.kill('SIGKILL');
        resolve();
      }, 12000);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const report = {
    status: 'passed',
    checkedAt: new Date().toISOString(),
    isolatedDatabase: source.name,
    restoreDatabase: target.name,
    checks,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/m1-integration.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  await restoredApp.close();
  await pool.end();
  await restoredPool.end();
  await source.destroy();
  await target.destroy();
}
