import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createPool, loadEnvironment } from '@dayzero/db';
import { commitProof } from '@dayzero/workflows';

loadEnvironment();
const pool = createPool();
const runId = `m0-${randomUUID()}`;
const phases: unknown[] = [];

function phase(name: string, id: string, expectedExit = 0) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/workflow-phase.ts', name, id],
    {
      encoding: 'utf8',
      env: process.env,
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    expectedExit,
    `Phase ${name}: ${result.stderr || result.error?.message}`,
  );
  const output = result.stdout.trim()
    ? JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    : { phase: name, exitCode: result.status };
  phases.push(output);
  return output;
}

async function count(table: 'workflow_commits' | 'outbox', id: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) FROM m0.${table} WHERE operation_id = $1`,
    [id],
  );
  return Number(result.rows[0]?.count);
}

try {
  const start = phase('start', runId);
  assert.equal(start.waiting, true);
  assert.equal(
    await count('workflow_commits', runId),
    0,
    'No write before approval',
  );
  phase('crash', runId, 86);
  assert.equal(
    await count('workflow_commits', runId),
    1,
    'Commit survives abrupt process exit',
  );
  assert.equal(await count('outbox', runId), 1);
  const recovered = phase('recover', runId);
  assert.ok(recovered.nodeId);
  assert.deepEqual(recovered.pending, []);
  const replay = phase('recover', runId);
  assert.equal(replay.nodeId, recovered.nodeId);
  const repeated = await Promise.all(
    Array.from({ length: 8 }, () =>
      commitProof(pool, runId, 'M0 · 人工确认验证'),
    ),
  );
  assert.ok(repeated.every((id) => id === recovered.nodeId));
  assert.equal(await count('workflow_commits', runId), 1);
  assert.equal(await count('outbox', runId), 1);
  await assert.rejects(
    () => commitProof(pool, runId, 'Different content'),
    /different content/,
  );
  const rejectedId = `${runId}-reject`;
  phase('start', rejectedId);
  phase('reject', rejectedId);
  assert.equal(await count('workflow_commits', rejectedId), 0);
  const report = {
    status: 'passed',
    runId,
    checkedAt: new Date().toISOString(),
    checks: [
      'no-write-before-confirmation',
      'persistent-interrupt-across-processes',
      'post-commit-crash-recovery',
      'finished-thread-replay',
      'concurrent-idempotent-submit',
      'payload-conflict-rejected',
      'rejection-does-not-write',
    ],
    phases,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/workflow.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
