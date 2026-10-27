import { createPool, loadEnvironment } from '@dayzero/db';
import { createApp } from './app.ts';

loadEnvironment();
const pool = createPool();
const app = createApp(pool);
app.addHook('onClose', async () => {
  await pool.end();
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void app.close();
  });
}
await app.listen({
  port: Number(process.env.PORT ?? 3188),
  host: process.env.HOST ?? '127.0.0.1',
});
