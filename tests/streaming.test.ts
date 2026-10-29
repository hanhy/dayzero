import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { readSseEvents, explanationPrompt } from '@dayzero/contracts';
import {
  ModelGateway,
  type ModelConnection,
} from '../apps/server/src/model-gateway.ts';
import { ModelProfiles } from '../apps/server/src/model-profiles.ts';
const encode = new TextEncoder();
function bytes(text: string, size = 1) {
  const input = encode.encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < input.length; i += size)
        controller.enqueue(input.slice(i, i + size));
      controller.close();
    },
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('incremental SSE', () => {
  it('preserves Chinese UTF-8 across byte boundaries, CRLF and multi-line data', async () => {
    const events = [];
    for await (const event of readSseEvents(
      bytes(
        ': ping\r\nevent: delta\r\ndata: 中文\r\ndata: 第二行\r\n\r\ndata: [DONE]\n\n',
      ),
    ))
      events.push(event);
    expect(events).toEqual([
      { event: 'delta', data: '中文\n第二行' },
      { event: 'message', data: '[DONE]' },
    ]);
  });
  it('does not treat a truncated event as a complete result', async () => {
    const events = [];
    for await (const event of readSseEvents(bytes('data: incomplete')))
      events.push(event);
    expect(events).toEqual([]);
  });
  it('uses the exact simple question requested', () =>
    expect(explanationPrompt('  ETH  ')).toBe(
      'ETH是什么？请以最简单的方式介绍它的概念',
    ));
});
const profile: ModelConnection = {
  id: '4bd5d33b-4666-4522-a326-fb55f4f1374e',
  version: 'fixture',
  purpose: 'chat',
  baseUrl: 'https://example.invalid/v1',
  modelId: 'fixture-model',
  apiKey: 'fixture-secret',
};
describe('true model streaming', () => {
  it('delivers a delta before the provider finishes, ignores reasoning and records real usage', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    let finish: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        expect(body.stream).toBe(true);
        expect(body.messages).toEqual([
          { role: 'user', content: explanationPrompt('ETH') },
        ]);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encode.encode(
                'data: {"choices":[{"delta":{"reasoning_content":"not visible"}}]}\n\ndata: {"choices":[{"delta":{"content":"指数时间"}}]}\n\n',
              ),
            );
            finish = () => {
              controller.enqueue(
                encode.encode(
                  'data: {"choices":[{"delta":{"content":"假设。"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            };
          },
        });
        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    const output = new ModelGateway(pool, new ModelProfiles(pool)).streamText(
      profile,
      explanationPrompt('ETH'),
      new AbortController().signal,
    );
    expect(await output.next()).toMatchObject({
      value: '指数时间',
      done: false,
    });
    finish();
    expect(await output.next()).toMatchObject({ value: '假设。', done: false });
    expect((await output.next()).done).toBe(true);
    expect(vi.mocked(pool.query).mock.calls.at(-1)?.[1]).toEqual([
      expect.any(String),
      profile.id,
      'word-explanation',
      expect.any(Number),
      { total_tokens: 12 },
      'ok',
    ]);
  });
  it('reports a disconnected response instead of declaring partial output complete', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            bytes('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n'),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );
    const output = new ModelGateway(pool, new ModelProfiles(pool)).streamText(
      profile,
      'fixture',
      new AbortController().signal,
    );
    expect((await output.next()).value).toBe('未完成');
    await expect(output.next()).rejects.toThrow('流式连接意外中断');
  });
});
