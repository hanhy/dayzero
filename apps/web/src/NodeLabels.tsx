import { useMemo, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { BenchmarkGraph } from '@dayzero/contracts';

export const LABEL_LIMIT = 24;

// A fixed pool of small HTML labels avoids creating one DOM element per node.
export default function NodeLabels({
  graph,
  positions,
  selected,
  labels,
  overlay,
}: {
  graph: BenchmarkGraph;
  positions: Float32Array;
  selected: number | null;
  labels?: string[];
  overlay: RefObject<HTMLDivElement | null>;
}) {
  const view = useMemo(() => new THREE.Vector3(), []);
  const projected = useMemo(() => new THREE.Vector3(), []);
  const visible = useMemo(() => new Set<number>(), [graph]);
  useFrame(({ camera, size }) => {
    if (!overlay.current) return;
    const candidates: {
      index: number;
      x: number;
      y: number;
      diameter: number;
    }[] = [];
    for (let index = 0; index < graph.nodes.length; index++) {
      view
        .fromArray(positions, index * 3)
        .applyMatrix4(camera.matrixWorldInverse);
      if (view.z >= -camera.near) {
        visible.delete(index);
        continue;
      }
      // Match PointsMaterial's size attenuation and the selected sprite's projection.
      const diameter =
        (index === selected
          ? (1.9 * size.height * camera.projectionMatrix.elements[5]!) / 2
          : (1.5 * size.height) / 2) / -view.z;
      // Hysteresis prevents flickering when drifting around the zoom threshold.
      if (diameter < (visible.has(index) ? 7 : 8)) {
        visible.delete(index);
        continue;
      }
      projected.fromArray(positions, index * 3).project(camera);
      if (
        Math.abs(projected.x) > 1 ||
        Math.abs(projected.y) > 1 ||
        Math.abs(projected.z) > 1
      )
        continue;
      visible.add(index);
      candidates.push({
        index,
        x: ((projected.x + 1) * size.width) / 2,
        y: ((1 - projected.y) * size.height) / 2,
        diameter,
      });
    }
    candidates.sort(
      (a, b) =>
        Number(b.index === selected) - Number(a.index === selected) ||
        b.diameter - a.diameter,
    );
    const occupied: { x: number; y: number; width: number }[] = [];
    let slot = 0;
    for (const node of candidates) {
      if (slot >= LABEL_LIMIT) break;
      const text = labels?.[node.index] ?? graph.nodes[node.index]!.label;
      const width = Math.min(160, [...text].length * 11) + 4;
      const x = node.x + node.diameter / 2 + 7,
        y = node.y - 8;
      if (x + width > size.width || y < 0 || y + 16 > size.height) continue;
      if (
        occupied.some(
          (box) =>
            x < box.x + box.width + 6 &&
            x + width + 6 > box.x &&
            Math.abs(y - box.y) < 20,
        )
      )
        continue;
      const element = overlay.current.children[slot++] as HTMLSpanElement;
      if (element.textContent !== text) element.textContent = text;
      element.style.display = 'block';
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      occupied.push({ x, y, width });
    }
    for (; slot < LABEL_LIMIT; slot++)
      (overlay.current.children[slot] as HTMLSpanElement).style.display =
        'none';
  });
  return null;
}
