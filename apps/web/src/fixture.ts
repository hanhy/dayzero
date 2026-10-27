import type { BenchmarkGraph } from '@dayzero/contracts';

// Seeded geometry only: no LLM classification, domain colors or real knowledge data.
export function createBenchmark(
  seed = 20261027,
  count = 1000,
  edgeCount = 5000,
): BenchmarkGraph {
  if (count < 2 || edgeCount > (count * (count - 1)) / 2)
    throw new Error('Invalid fixture size');
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const nodes = Array.from({ length: count }, (_, id) => {
    const theta = random() * Math.PI * 2;
    const z = random() * 2 - 1;
    const radius = 28 + Math.pow(random(), 0.55) * 80;
    const ring = Math.sqrt(1 - z * z);
    return {
      id,
      label: `基准节点 ${String(id + 1).padStart(4, '0')}`,
      position: [
        radius * ring * Math.cos(theta) * 1.35,
        radius * z * 0.72,
        radius * ring * Math.sin(theta),
      ] as [number, number, number],
    };
  });
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  while (edges.length < edgeCount) {
    const first = Math.floor(random() * count);
    const second = Math.floor(random() * count);
    const a = Math.min(first, second),
      b = Math.max(first, second);
    const key = `${a}:${b}`;
    if (a !== b && !seen.has(key)) {
      edges.push([a, b]);
      seen.add(key);
    }
  }
  return { nodes, edges };
}
