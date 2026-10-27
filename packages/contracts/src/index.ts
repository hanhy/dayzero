export type HealthResponse = {
  status: 'ok' | 'degraded';
  database: 'ready' | 'unavailable';
  migrations: 'ready' | 'pending' | 'unknown';
  milestone: 'M0' | 'M1';
};

export type BenchmarkNode = {
  id: number;
  label: string;
  position: [number, number, number];
};

export type BenchmarkGraph = {
  nodes: BenchmarkNode[];
  edges: [number, number][];
};

export * from './knowledge.ts';
