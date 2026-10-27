import { describe, expect, it } from 'vitest';
import { createBenchmark } from '../apps/web/src/fixture.ts';

describe('M0 benchmark fixture', () => {
  it('keeps a stable 1,000-node / 5,000-edge workload without duplicate or self edges', () => {
    const graph = createBenchmark();
    expect(graph).toEqual(createBenchmark());
    expect(graph.nodes).toHaveLength(1000);
    expect(graph.edges).toHaveLength(5000);
    expect(new Set(graph.edges.map(([a, b]) => `${a}:${b}`)).size).toBe(5000);
    expect(graph.edges.every(([a, b]) => a < b && a >= 0 && b < 1000)).toBe(
      true,
    );
    expect(graph.nodes.every((n) => n.position.every(Number.isFinite))).toBe(
      true,
    );
  });
});
