import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';

let env: string;
try {
  env = await readFile('.env', 'utf8');
} catch {
  env = await readFile('.env.example', 'utf8');
}
const existing = env.match(/^MODEL_MASTER_KEY=(.*)$/m)?.[1]?.trim();
if (existing) {
  if (Buffer.from(existing, 'base64').length !== 32)
    throw new Error(
      'Existing MODEL_MASTER_KEY is invalid; it was not changed.',
    );
  console.log('Existing model encryption key preserved.');
} else {
  const line = `MODEL_MASTER_KEY=${randomBytes(32).toString('base64')}`;
  env = /^MODEL_MASTER_KEY=.*$/m.test(env)
    ? env.replace(/^MODEL_MASTER_KEY=.*$/m, line)
    : `${env.trimEnd()}\n${line}\n`;
  await writeFile('.env', env, { mode: 0o600 });
  await chmod('.env', 0o600);
  console.log(
    'Model encryption key initialized in ignored .env (value not printed).',
  );
}
