import { PgBoss } from 'pg-boss';
import { createPool, databaseUrl, loadEnvironment } from '@dayzero/db';
import { acknowledgeEvent, dispatchOutbox } from './outbox.ts';

loadEnvironment();
const boss = new PgBoss(databaseUrl());
const pool = createPool();
boss.on('error', (error) =>
  console.error(
    JSON.stringify({ event: 'worker.error', message: error.message }),
  ),
);
await boss.start();
await boss.createQueue('knowledge.events');
await boss.work<{ eventId: string; kind: string }>(
  'knowledge.events',
  { batchSize: 20, pollingIntervalSeconds: 1 },
  async (jobs) => {
    for (const job of jobs) {
      const firstDelivery = await acknowledgeEvent(pool, job.data.eventId);
      if (firstDelivery)
        console.log(
          JSON.stringify({
            event: 'knowledge.event.delivered',
            id: job.data.eventId,
            kind: job.data.kind,
          }),
        );
    }
  },
);
let dispatching = false;
const dispatch = async () => {
  if (dispatching) return;
  dispatching = true;
  try {
    await dispatchOutbox(pool, boss);
  } catch {
    console.error(
      JSON.stringify({
        event: 'outbox.retry',
        message: 'Delivery deferred; will retry',
      }),
    );
  } finally {
    dispatching = false;
  }
};
await dispatch();
const timer = setInterval(() => {
  void dispatch();
}, 2000);
await boss.createQueue('m0.health');
await boss.work('m0.health', async (jobs) => {
  for (const job of jobs)
    console.log(JSON.stringify({ event: 'worker.job', id: job.id }));
});
await boss.send('m0.health', { milestone: 'M0' });
console.log(JSON.stringify({ event: 'worker.ready', milestone: 'M1' }));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    clearInterval(timer);
    void boss.stop({ graceful: true, timeout: 10_000 }).then(() => pool.end());
  });
}
