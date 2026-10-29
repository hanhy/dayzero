import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  ModelGateway,
  type ModelConnection,
} from '../apps/server/src/model-gateway.ts';
import { ModelProfiles } from '../apps/server/src/model-profiles.ts';
const profile: ModelConnection = {
  id: '4bd5d33b-4666-4522-a326-fb55f4f1374e',
  version: 'test',
  purpose: 'embedding',
  baseUrl: 'https://example.invalid/v1',
  modelId: 'text-embedding-v4',
  apiKey: 'fixture-secret',
};
const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool;
const gateway = () => new ModelGateway(pool, new ModelProfiles(pool));
const context = { purpose: 'query-embedding' };
afterEach(() => vi.unstubAllGlobals());

describe('embedding provider boundaries', () => {
  it('splits 24 inputs into 10/10/4 and preserves order when batch indices restart', async () => {
    const sizes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        sizes.push(body.input.length);
        expect(body.encoding_format).toBe('float');
        if (body.input.length > 10) return new Response('{}', { status: 400 });
        return Response.json({
          data: body.input
            .map((text: string, index: number) => ({
              index,
              embedding: [Number(text) + 1, 1],
            }))
            .reverse(),
        });
      }),
    );
    const vectors = await gateway().embed(
      profile,
      Array.from({ length: 24 }, (_, i) => String(i)),
      context,
    );
    expect(sizes).toEqual([10, 10, 4]);
    expect(vectors.map((v) => v[0])).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
  });
  it('rejects dimension changes between provider batches', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        call++;
        return Response.json({
          data: body.input.map((_: string, index: number) => ({
            index,
            embedding: call === 1 ? [1, 2] : [1, 2, 3],
          })),
        });
      }),
    );
    await expect(
      gateway().embed(profile, Array(11).fill('fixture'), context),
    ).rejects.toThrow('跨批次向量维度不一致');
  });
  it('explains a Token Plan embedding 404 without exposing response or key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: profile.apiKey }), {
            status: 404,
          }),
      ),
    );
    await expect(
      gateway().embed(
        {
          ...profile,
          baseUrl:
            'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        },
        ['fixture'],
        context,
      ),
    ).rejects.toThrow('请改用百炼通用向量服务地址和对应通用 API Key');
  });
  it('explains credential mismatches for embedding authentication errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    await expect(
      gateway().embed(profile, ['fixture'], context),
    ).rejects.toThrow('套餐专属 Key 不能与通用服务地址混用');
  });
});
