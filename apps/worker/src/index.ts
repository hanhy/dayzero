import { PgBoss } from 'pg-boss';
import { databaseUrl, loadEnvironment } from '@dayzero/db';

loadEnvironment();
const boss = new PgBoss(databaseUrl());
boss.on('error', (error) =>
  console.error(
    JSON.stringify({ event: 'worker.error', message: error.message }),
  ),
);
await boss.start();
await boss.createQueue('m0.health');
await boss.work('m0.health', async (jobs) => {
  for (const job of jobs)
    console.log(JSON.stringify({ event: 'worker.job', id: job.id }));
});
await boss.send('m0.health', { milestone: 'M0' });
console.log(JSON.stringify({ event: 'worker.ready', milestone: 'M0' }));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void boss.stop({ graceful: true, timeout: 10_000 });
  });
}
