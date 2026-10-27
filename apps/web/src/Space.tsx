import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { BenchmarkGraph } from '@dayzero/contracts';
import { createDriftParameters, updateDriftPositions } from './motion.ts';
import {
  createRoundPointMaterial,
  createRoundSpriteMaterial,
} from './circle-materials.ts';

export type CameraMode = 'orbit' | 'fly';
export type Metrics = {
  fps: number;
  frameMs: number;
  calls: number;
  renderer: string;
  cameraPosition: [number, number, number];
  mode: CameraMode;
};

class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="fallback">
        三维场景暂不可用。右侧仍可选择并阅读基准节点。
      </div>
    ) : (
      this.props.children
    );
  }
}

function CameraRig({
  mode,
  onMode,
  reset,
  focus,
  graph,
  positions,
  onMetrics,
}: {
  mode: CameraMode;
  onMode: (value: CameraMode) => void;
  reset: number;
  focus: number | null;
  graph: BenchmarkGraph;
  positions: Float32Array;
  onMetrics: (value: Metrics) => void;
}) {
  const { camera, gl } = useThree();
  const orbit = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const keys = useRef(new Set<string>());
  const frames = useRef({ elapsed: 0, count: 0 });
  const vector = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    camera.position.set(0, 85, 265);
    camera.lookAt(0, 0, 0);
    orbit.current?.target.set(0, 0, 0);
    orbit.current?.update();
  }, [camera, reset]);
  useEffect(() => {
    if (focus === null) return;
    if (!graph.nodes[focus]) return;
    const target = new THREE.Vector3().fromArray(positions, focus * 3);
    camera.position.set(target.x + 20, target.y + 12, target.z + 36);
    camera.lookAt(target);
    orbit.current?.target.copy(target);
    orbit.current?.update();
  }, [focus, camera, graph, positions]);
  useEffect(() => {
    if (mode === 'orbit') {
      keys.current.clear();
      if (document.pointerLockElement === gl.domElement)
        document.exitPointerLock();
      const direction = camera.getWorldDirection(new THREE.Vector3());
      orbit.current?.target
        .copy(camera.position)
        .addScaledVector(direction, 60);
      orbit.current?.update();
    }
  }, [mode, camera, gl]);
  useEffect(() => {
    const editing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        /INPUT|TEXTAREA|SELECT/.test(target.tagName));
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        keys.current.clear();
        onMode('orbit');
        return;
      }
      if (editing(event.target) || mode !== 'fly') return;
      if (
        ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(event.code)
      ) {
        event.preventDefault();
        keys.current.add(event.code);
      }
    };
    const up = (event: KeyboardEvent) => {
      keys.current.delete(event.code);
    };
    const clear = () => keys.current.clear();
    const move = (event: MouseEvent) => {
      if (mode !== 'fly' || document.pointerLockElement !== gl.domElement)
        return;
      camera.rotation.order = 'YXZ';
      camera.rotation.y -= event.movementX * 0.002;
      camera.rotation.x = THREE.MathUtils.clamp(
        camera.rotation.x - event.movementY * 0.002,
        -1.5,
        1.5,
      );
    };
    const lock = () => {
      if (mode === 'fly' && document.pointerLockElement !== gl.domElement) {
        clear();
        onMode('orbit');
      }
    };
    const click = () => {
      if (mode === 'fly' && !document.pointerLockElement)
        void gl.domElement.requestPointerLock()?.catch(() => onMode('orbit'));
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    window.addEventListener('focusin', clear);
    document.addEventListener('mousemove', move);
    document.addEventListener('pointerlockchange', lock);
    gl.domElement.addEventListener('click', click);
    return () => {
      clear();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      window.removeEventListener('focusin', clear);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('pointerlockchange', lock);
      gl.domElement.removeEventListener('click', click);
    };
  }, [mode, camera, gl, onMode]);
  useFrame((_state, dt) => {
    if (mode === 'fly') {
      const key = keys.current;
      vector.set(
        Number(key.has('KeyD')) - Number(key.has('KeyA')),
        Number(key.has('KeyE')) - Number(key.has('KeyQ')),
        Number(key.has('KeyS')) - Number(key.has('KeyW')),
      );
      if (vector.lengthSq())
        camera.position.add(
          vector
            .normalize()
            .applyQuaternion(camera.quaternion)
            .multiplyScalar(Math.min(dt, 0.05) * 65),
        );
    }
    frames.current.elapsed += dt;
    frames.current.count++;
    if (frames.current.elapsed >= 1) {
      const renderer = gl
        .getContext()
        .getParameter(gl.getContext().RENDERER) as string;
      onMetrics({
        fps: Math.round(frames.current.count / frames.current.elapsed),
        frameMs:
          Math.round(
            ((frames.current.elapsed * 1000) / frames.current.count) * 10,
          ) / 10,
        calls: gl.info.render.calls,
        renderer,
        cameraPosition: camera.position.toArray() as [number, number, number],
        mode,
      });
      frames.current = { elapsed: 0, count: 0 };
    }
  });
  return (
    <OrbitControls
      ref={orbit}
      enabled={mode === 'orbit'}
      enableDamping
      dampingFactor={0.08}
      minDistance={3}
      maxDistance={700}
    />
  );
}

function createEdgeLayer(
  links: BenchmarkGraph['edges'],
  positions: Float32Array,
  highlighted = false,
) {
  const endpoints = new Float32Array(links.length * 6);
  links.forEach(([a, b], i) => {
    endpoints.set(positions.subarray(a * 3, a * 3 + 3), i * 6);
    endpoints.set(positions.subarray(b * 3, b * 3 + 3), i * 6 + 3);
  });
  const geometry = new LineSegmentsGeometry().setPositions(endpoints);
  const buffer = (
    geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute
  ).data;
  buffer.setUsage(THREE.DynamicDrawUsage);
  geometry.boundingSphere!.radius += 13;
  geometry.boundingBox!.expandByScalar(13);
  const material = new LineMaterial({
    color: highlighted ? '#81bfc8' : '#639a9e',
    linewidth: highlighted ? 1.5 : 1,
    transparent: true,
    opacity: highlighted ? 0.45 : 0.045,
    depthWrite: false,
  });
  const line = new LineSegments2(geometry, material);
  line.renderOrder = highlighted ? 1 : 0;
  // Edges are visual context; node picking should pass through them.
  line.raycast = () => {};
  return line;
}

function syncEdgeLayer(
  line: LineSegments2,
  links: BenchmarkGraph['edges'],
  positions: Float32Array,
) {
  const buffer = (
    line.geometry.getAttribute(
      'instanceStart',
    ) as THREE.InterleavedBufferAttribute
  ).data;
  const endpoints = buffer.array as Float32Array;
  for (let i = 0; i < links.length; i++) {
    const [a, b] = links[i]!;
    for (let axis = 0; axis < 3; axis++) {
      endpoints[i * 6 + axis] = positions[a * 3 + axis]!;
      endpoints[i * 6 + 3 + axis] = positions[b * 3 + axis]!;
    }
  }
  buffer.needsUpdate = true;
}

function Geometry({
  graph,
  positions,
  selected,
  onSelect,
  showEdges,
}: {
  graph: BenchmarkGraph;
  positions: Float32Array;
  selected: number | null;
  onSelect: (id: number) => void;
  showEdges: boolean;
}) {
  const pointMaterial = useMemo(createRoundPointMaterial, []);
  const coreMaterial = useMemo(() => createRoundSpriteMaterial(), []);
  const glowMaterial = useMemo(() => createRoundSpriteMaterial(true), []);
  const drift = useMemo(
    () => createDriftParameters(graph.nodes.length),
    [graph],
  );
  const elapsed = useRef(0);
  const selectedMarker = useRef<THREE.Group>(null);
  const selectedCore = useRef<THREE.Sprite>(null);
  const selectedGlow = useRef<THREE.Sprite>(null);
  useEffect(
    () => () => {
      pointMaterial.dispose();
      coreMaterial.dispose();
      glowMaterial.dispose();
    },
    [pointMaterial, coreMaterial, glowMaterial],
  );
  const points = useMemo(() => {
    const geometry = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.computeBoundingSphere();
    geometry.boundingSphere!.radius += 13;
    geometry.setIndex(Array.from({ length: graph.nodes.length }, (_, i) => i));
    return geometry;
  }, [positions, graph]);
  useEffect(() => {
    // Replace the selected node's ordinary disc, so its center can truly blink.
    const index = points.getIndex()!;
    let count = 0;
    for (let i = 0; i < graph.nodes.length; i++) {
      if (i !== selected) index.setX(count++, i);
    }
    index.needsUpdate = true;
    points.setDrawRange(0, count);
  }, [points, graph, selected]);
  const edges = useMemo(
    () => createEdgeLayer(graph.edges, positions),
    [graph, positions],
  );
  const incidentEdges = useMemo(
    () =>
      selected === null
        ? []
        : graph.edges.filter(([a, b]) => a === selected || b === selected),
    [graph, selected],
  );
  const highlightedEdges = useMemo(
    () =>
      incidentEdges.length
        ? createEdgeLayer(incidentEdges, positions, true)
        : null,
    [incidentEdges, positions],
  );
  useEffect(
    () => () => {
      highlightedEdges?.geometry.dispose();
      highlightedEdges?.material.dispose();
    },
    [highlightedEdges],
  );
  useFrame(({ camera }, dt) => {
    // Small bounded steps avoid jumping when returning from a background tab.
    elapsed.current += Math.min(dt, 0.05);
    updateDriftPositions(graph, drift, elapsed.current, positions);
    points.getAttribute('position').needsUpdate = true;
    if (selected !== null) {
      selectedMarker.current?.position.fromArray(positions, selected * 3);
      const pulse = ((Math.sin(elapsed.current * 3.4) + 1) / 2) ** 2;
      if (selectedCore.current) {
        selectedCore.current.material.opacity = 0.15 + pulse * 0.85;
        selectedCore.current.scale.setScalar(1.8 + pulse * 0.2);
      }
      if (selectedGlow.current)
        selectedGlow.current.material.opacity = 0.06 + pulse * 0.32;
    }
    if (!showEdges) return;
    syncEdgeLayer(edges, graph.edges, positions);
    const zoom =
      1 - THREE.MathUtils.smoothstep(camera.position.length(), 80, 280);
    // Screen-space width stays readable up close without overwhelming the overview.
    edges.material.linewidth = THREE.MathUtils.damp(
      edges.material.linewidth,
      1 + zoom * 1.2,
      8,
      dt,
    );
    edges.material.opacity = THREE.MathUtils.damp(
      edges.material.opacity,
      selected === null ? 0.045 + zoom * 0.075 : 0.022 + zoom * 0.035,
      8,
      dt,
    );
    if (highlightedEdges) {
      syncEdgeLayer(highlightedEdges, incidentEdges, positions);
      highlightedEdges.material.linewidth = 1.5 + zoom * 0.55;
    }
  });
  useEffect(
    () => () => {
      points.dispose();
      edges.geometry.dispose();
      edges.material.dispose();
    },
    [points, edges],
  );
  const node = selected === null ? null : graph.nodes[selected];
  return (
    <>
      {showEdges && <primitive object={edges} />}
      {showEdges && highlightedEdges && <primitive object={highlightedEdges} />}
      <points
        renderOrder={2}
        geometry={points}
        onPointerDown={(event) => {
          if (event.index !== undefined) {
            event.stopPropagation();
            onSelect(event.index);
          }
        }}
      >
        <primitive object={pointMaterial} attach="material" />
      </points>
      {node && (
        <group ref={selectedMarker}>
          <sprite ref={selectedGlow} scale={[3, 3, 1]} renderOrder={3}>
            <primitive object={glowMaterial} attach="material" />
          </sprite>
          <sprite ref={selectedCore} renderOrder={5}>
            <primitive object={coreMaterial} attach="material" />
          </sprite>
        </group>
      )}
    </>
  );
}

export default function Space(props: {
  graph: BenchmarkGraph;
  mode: CameraMode;
  onMode: (value: CameraMode) => void;
  selected: number | null;
  onSelect: (id: number) => void;
  reset: number;
  focus: number | null;
  showEdges: boolean;
  onMetrics: (metrics: Metrics) => void;
}) {
  const positions = useMemo(() => {
    const array = new Float32Array(props.graph.nodes.length * 3);
    props.graph.nodes.forEach((node, i) => array.set(node.position, i * 3));
    return array;
  }, [props.graph]);
  return (
    <SceneBoundary>
      <Canvas
        camera={{ position: [0, 85, 265], fov: 48, near: 0.1, far: 1800 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        raycaster={{
          params: {
            Mesh: {},
            LOD: {},
            Sprite: {},
            Points: { threshold: 2 },
            Line: { threshold: 1 },
          },
        }}
        fallback={
          <div className="fallback">
            当前浏览器不支持 WebGL，请使用右侧节点列表。
          </div>
        }
      >
        <color attach="background" args={['#0a1015']} />
        <Geometry
          graph={props.graph}
          positions={positions}
          selected={props.selected}
          onSelect={props.onSelect}
          showEdges={props.showEdges}
        />
        <CameraRig
          graph={props.graph}
          positions={positions}
          mode={props.mode}
          onMode={props.onMode}
          reset={props.reset}
          focus={props.focus}
          onMetrics={props.onMetrics}
        />
      </Canvas>
    </SceneBoundary>
  );
}
