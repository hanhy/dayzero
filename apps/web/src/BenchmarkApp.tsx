import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HealthResponse } from '@dayzero/contracts';
import Space, { type CameraMode, type Metrics } from './Space.tsx';
import { createBenchmark } from './fixture.ts';

export default function BenchmarkApp() {
  const graph = useMemo(() => createBenchmark(), []);
  const [mode, setMode] = useState<CameraMode>('orbit');
  const [selected, setSelected] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [reset, setReset] = useState(0);
  const [showEdges, setShowEdges] = useState(true);
  const [search, setSearch] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [evidence, setEvidence] = useState<Record<
    string,
    { status: string; checkedAt?: string }
  > | null>(null);
  const onMetrics = useCallback((value: Metrics) => {
    setMetrics(value);
    window.dispatchEvent(
      new CustomEvent('dayzero:benchmark', { detail: value }),
    );
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
    void fetch('/api/m0/evidence', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(setEvidence)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const visible = graph.nodes
    .filter((node) => !search || node.label.includes(search))
    .slice(0, 5);
  const node = selected === null ? null : graph.nodes[selected];
  const home = () => {
    setMode('orbit');
    setFocus(null);
    setReset((n) => n + 1);
  };
  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-mark">
          d<span>·</span>
        </div>
        <button
          className="rail-icon active"
          aria-label="知识空间"
          title="知识空间"
        >
          ✧
        </button>
        <div className="rail-bottom">M0</div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="brand">
            dayzero<span>个人知识空间</span>
          </div>
          <div className="top-status">
            <span className="live-dot" />
            本地开发 <span className="milestone">M0 / FOUNDATION</span>
          </div>
        </header>
        <main>
          <section className="space-panel" aria-label="三维基准场景">
            <div className="space-header">
              <div>
                <p className="eyebrow">YOUR KNOWLEDGE, CONNECTED</p>
                <h1>
                  知识空间<span> / 技术预览</span>
                </h1>
                <p className="space-description">
                  先建立可靠的连接，再让知识形成自己的宇宙。
                </p>
              </div>
              <span className="outline-tag">基准数据 · 非个人知识</span>
            </div>
            <div className="canvas-wrap" data-testid="space-scene">
              <Space
                graph={graph}
                mode={mode}
                onMode={setMode}
                selected={selected}
                onSelect={setSelected}
                reset={reset}
                focus={focus}
                showEdges={showEdges}
                onMetrics={onMetrics}
              />
              <div className="scene-guide">
                <span className="crosshair">+</span>
                <span>DETERMINISTIC SCENE</span>
                <span>SEED 20261027</span>
              </div>
              <div className="scene-caption">
                <span className="caption-line" />
                <div>
                  每一个点，都是一个出发点。
                  <small>
                    本场景仅验证渲染与导航，尚未接入真实知识或语义聚类。
                  </small>
                </div>
              </div>
            </div>
            <div className="toolbar">
              <div className="segmented">
                <button
                  className={mode === 'orbit' ? 'selected' : ''}
                  onClick={() => setMode('orbit')}
                  aria-pressed={mode === 'orbit'}
                >
                  轨道观察
                </button>
                <button
                  className={mode === 'fly' ? 'selected' : ''}
                  onClick={() => setMode('fly')}
                  aria-pressed={mode === 'fly'}
                >
                  自由飞行
                </button>
              </div>
              <button className="quiet-button" onClick={home}>
                ↗ 返回全景
              </button>
              <label className="edge-toggle">
                <input
                  type="checkbox"
                  checked={showEdges}
                  onChange={(e) => setShowEdges(e.target.checked)}
                />
                显示基准边
              </label>
            </div>
            <div className="navigation-hint" data-testid="navigation-mode">
              {mode === 'fly'
                ? '飞行模式 · 点击场景控制视角 · WASD 移动 / QE 上下 / Esc 退出'
                : '轨道模式 · 拖动旋转 / 右键平移 / 滚轮缩放 / 点击节点查看'}
            </div>
            <div className="metrics">
              <div>
                <strong>1,000</strong>
                <span>基准节点</span>
              </div>
              <div>
                <strong>5,000</strong>
                <span>基准边</span>
              </div>
              <div>
                <strong data-testid="fps">
                  {metrics?.fps ?? '—'}
                  <em> FPS</em>
                </strong>
                <span>实时帧率</span>
              </div>
              <div>
                <strong>{metrics?.calls ?? '—'}</strong>
                <span>绘制调用</span>
              </div>
              <span className="metrics-label">
                WEBGL BENCHMARK <span className="live-dot" />
              </span>
            </div>
          </section>
          <aside className="inspector">
            <div className="section-heading">
              <span>01 / 节点检查</span>
              <span className="little-mark">↗</span>
            </div>
            <h2>{node?.label ?? '探索一个知识点'}</h2>
            <p className="muted">
              {node
                ? '已选中基准节点，可定位并检查坐标。'
                : '点击空间中的点，或从下方列表选择。'}
            </p>
            <div className="search-box">
              <span>⌕</span>
              <input
                aria-label="搜索基准节点"
                placeholder="搜索基准节点编号…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="node-list">
              {visible.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelected(item.id)}
                  className={
                    selected === item.id ? 'node-row chosen' : 'node-row'
                  }
                >
                  <span className="node-dot" />
                  {item.label}
                  <span>↗</span>
                </button>
              ))}
              {!visible.length && <p className="muted">没有匹配的基准节点</p>}
            </div>
            {node && (
              <div className="node-detail">
                <p>POSITION / XYZ</p>
                <code>
                  {node.position.map((n) => n.toFixed(1)).join(' / ')}
                </code>
                <button
                  className="primary-button"
                  onClick={() => {
                    setMode('orbit');
                    setFocus(node.id);
                  }}
                >
                  定位这个节点 ↗
                </button>
              </div>
            )}
            <div className="divider" />
            <div className="section-heading">
              <span>02 / 基础设施</span>
              <span className="little-mark">◈</span>
            </div>
            <div className="readiness">
              <span
                className={`status-dot ${health?.status === 'ok' ? 'ready' : ''}`}
              />
              <div>
                <strong>PostgreSQL + pgvector</strong>
                <small>
                  {health?.status === 'ok'
                    ? '数据库与迁移已就绪'
                    : health?.database === 'ready'
                      ? '数据库在线，迁移待完成'
                      : '等待数据库或 API 服务'}
                </small>
              </div>
            </div>
            <div className="proof-row">
              <span>工作流暂停与恢复</span>
              <span
                className={
                  evidence?.workflow?.status === 'passed'
                    ? 'proof-pass'
                    : 'proof-pending'
                }
              >
                {evidence?.workflow?.status === 'passed'
                  ? '已验证'
                  : '待运行 CLI'}
              </span>
            </div>
            <div className="proof-row">
              <span>Leiden 计算接口</span>
              <span
                className={
                  evidence?.clustering?.status === 'passed'
                    ? 'proof-pass'
                    : 'proof-pending'
                }
              >
                {evidence?.clustering?.status === 'passed'
                  ? '已验证'
                  : '待运行 CLI'}
              </span>
            </div>
            <div className="scope-note">
              <span>M0 DEVELOPMENT NOTE</span>
              <p>
                当前只验证工程与技术路线。知识录入、Markdown 编辑和 AI
                关联建议将在后续里程碑接入。
              </p>
            </div>
          </aside>
        </main>
        <footer>
          <span>
            <span className="live-dot" /> FOUNDATION IN PROGRESS
          </span>
          <span>Dayzero / 从一个知识点开始</span>
          <span>BUILD 0.0.0</span>
        </footer>
      </div>
    </div>
  );
}
