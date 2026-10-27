import type { BenchmarkGraph } from '@dayzero/contracts';

export function createDriftParameters(count: number) {
  // Stable per-node variation: amplitude, speed and phase for each axis.
  const parameters = new Float32Array(count * 9);
  let seed = 48117;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const offset = i * 9 + axis * 3;
      parameters[offset] = 0.6 + random() ** 1.5 * 3;
      parameters[offset + 1] = 0.18 + random() * 0.42;
      parameters[offset + 2] = random() * Math.PI * 2;
    }
  }
  return parameters;
}

export function updateDriftPositions(
  graph: BenchmarkGraph,
  parameters: Float32Array,
  time: number,
  target: Float32Array,
) {
  for (let i = 0; i < graph.nodes.length; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const offset = i * 9 + axis * 3;
      const amplitude = parameters[offset]!;
      const speed = parameters[offset + 1]!;
      const phase = parameters[offset + 2]!;
      // Bounded motion around saved layout coordinates, continuous from t = 0.
      target[i * 3 + axis] =
        graph.nodes[i]!.position[axis]! +
        amplitude * (Math.sin(time * speed + phase) - Math.sin(phase));
    }
  }
}
