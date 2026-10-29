import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  BenchmarkGraph,
  HealthResponse,
  KnowledgeBackup,
  KnowledgeDraft,
  KnowledgeNode,
  KnowledgeRelation,
  Library,
} from '@dayzero/contracts';
import Space, { type CameraMode, type Metrics } from './Space.tsx';
import type { EditorHandle, Selection } from './KnowledgeEditor.tsx';
import { api, downloadText, mutation, operationId } from './api.ts';

const emptyLibrary: Library = { nodes: [], drafts: [], relations: [] };
const KnowledgeEditor = lazy(() => import('./KnowledgeEditor.tsx'));
const ModelSettings = lazy(() => import('./ModelSettings.tsx'));
type BackupPreview = {
  nodes: number;
  drafts: number;
  relations: number;
  canRestore: boolean;
};
export default function LibraryApp() {
  const [library, setLibrary] = useState<Library>(emptyLibrary),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [tab, setTab] = useState<'nodes' | 'drafts' | 'trash'>('nodes'),
    [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [editor, setEditor] = useState<Selection | null>(null);
  const [settings, setSettings] = useState(false),
    [mode, setMode] = useState<CameraMode>('orbit');
  const [showEdges, setShowEdges] = useState(true),
    [reset, setReset] = useState(0),
    [focus, setFocus] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null),
    [health, setHealth] = useState<HealthResponse | null>(null);
  const [busy, setBusy] = useState(false),
    [toast, setToast] = useState('');
  const [restore, setRestore] = useState<{
    backup: KnowledgeBackup;
    preview: BackupPreview;
    operationId: string;
  } | null>(null);
  const editorApi = useRef<EditorHandle | null>(null),
    markdownInput = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const result = await api<Library>('/api/knowledge');
    setLibrary(result);
    setLoading(false);
    setError('');
  }, []);
  useEffect(() => {
    void refresh().catch((error) => {
      setError(error.message);
      setLoading(false);
    });
    void api<HealthResponse>('/api/health')
      .then(setHealth)
      .catch(() => {});
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const onSaved = useCallback(
    (kind: Selection['kind'], value: KnowledgeNode | KnowledgeDraft) => {
      setLibrary((current) =>
        kind === 'node'
          ? {
              ...current,
              nodes: current.nodes.map((node) =>
                node.id === value.id ? (value as KnowledgeNode) : node,
              ),
            }
          : {
              ...current,
              drafts: current.drafts.map((draft) =>
                draft.id === value.id ? (value as KnowledgeDraft) : draft,
              ),
            },
      );
    },
    [],
  );
  const activeNodes = library.nodes.filter((node) => !node.deletedAt);
  const activeDrafts = library.drafts.filter(
    (draft) => !draft.deletedAt && !draft.committedNodeId,
  );
  const activeRelations = library.relations.filter((edge) => !edge.deletedAt);
  const graphSignature = JSON.stringify([
    activeNodes.map((node) => [node.id, ...node.position]),
    activeRelations.map((edge) => [edge.sourceId, edge.targetId]),
  ]);
  // Metadata edits do not reset the visual layout or jump the camera.
  const graph = useMemo<BenchmarkGraph>(() => {
    const indices = new Map(activeNodes.map((node, i) => [node.id, i]));
    return {
      nodes: activeNodes.map((node, i) => ({
        id: i,
        label: node.title,
        position: node.position,
      })),
      edges: activeRelations
        .filter(
          (edge) => indices.has(edge.sourceId) && indices.has(edge.targetId),
        )
        .map((edge) => [
          indices.get(edge.sourceId)!,
          indices.get(edge.targetId)!,
        ]),
    };
    // Layout identity deliberately excludes changing Markdown content.
  }, [graphSignature]);
  const selected = activeNodes.findIndex((node) => node.id === selectedId);
  const selectedNode = activeNodes.find((node) => node.id === selectedId);
  const editorRecord = editor
    ? (editor.kind === 'node' ? library.nodes : library.drafts).find(
        (item) => item.id === editor.id,
      )
    : null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = async (selection: Selection) => {
    try {
      await editorApi.current?.flush();
      setSettings(false);
      setEditor(selection);
      if (selection.kind === 'node') setSelectedId(selection.id);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const closeEditor = async () => {
    try {
      await editorApi.current?.flush();
      setEditor(null);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const create = () =>
    run(async () => {
      await editorApi.current?.flush();
      const draft = await mutation<KnowledgeDraft>('/api/drafts', {
        operationId: crypto.randomUUID(),
      });
      await refresh();
      setTab('drafts');
      setSettings(false);
      setEditor({ kind: 'draft', id: draft.id });
    });
  const committed = async (node: KnowledgeNode) => {
    await refresh();
    setTab('nodes');
    setSelectedId(node.id);
    setEditor({ kind: 'node', id: node.id });
    setToast('知识点已加入图谱');
  };
  const trash = async (
    record: KnowledgeNode | KnowledgeDraft,
    kind: Selection['kind'],
  ) => {
    await mutation(
      `/api/${kind === 'node' ? 'nodes' : 'drafts'}/${record.id}/delete`,
      {
        expectedRevision: record.revision,
        operationId: operationId(
          `trash:${kind}:${record.id}:${record.revision}`,
        ),
      },
    );
    await refresh();
    setEditor(null);
    if (kind === 'node') setSelectedId(null);
    setToast('已移入回收站，可随时恢复');
  };
  const recover = (
    kind: 'node' | 'draft' | 'relation',
    item: { id: string; revision: number },
  ) =>
    run(async () => {
      const result = await mutation<{
        restoredRelations: number;
        skippedRelations: number;
      }>(
        `/api/${kind === 'node' ? 'nodes' : kind === 'draft' ? 'drafts' : 'relations'}/${item.id}/restore`,
        {
          expectedRevision: item.revision,
          operationId: operationId(
            `recover:${kind}:${item.id}:${item.revision}`,
          ),
        },
      );
      await refresh();
      setToast(
        result.skippedRelations
          ? `已恢复；${result.skippedRelations} 条关联因端点或约束问题保持删除`
          : '已恢复',
      );
    });
  const matches = (item: KnowledgeNode | KnowledgeDraft) =>
    `${item.title}\n${item.markdown}\n${item.aliases.join(' ')}\n${item.tags.join(' ')}\n${item.sources.join(' ')}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase());
  const visible = (
    tab === 'nodes'
      ? activeNodes
      : tab === 'drafts'
        ? activeDrafts
        : [
            ...library.nodes.filter((node) => node.deletedAt),
            ...library.drafts.filter(
              (draft) => draft.deletedAt && !draft.committedNodeId,
            ),
          ]
  ).filter(matches);
  const deletedRelations = library.relations.filter((edge) => edge.deletedAt);
  const onMetrics = useCallback((value: Metrics) => setMetrics(value), []);

  return (
    <div className="app-shell library-app">
      <aside className="rail">
        <div className="brand-mark">
          d<span>·</span>
        </div>
        <button
          className="rail-icon active"
          title="知识空间"
          aria-label="知识空间"
          onClick={() => {
            void closeEditor();
          }}
        >
          ✧
        </button>
        <a className="benchmark-link" href="/?benchmark=1" title="三维基准场景">
          M0
        </a>
        <div className="rail-bottom">M2</div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="brand">
            dayzero<span>个人知识空间</span>
          </div>
          <nav className="library-actions">
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => markdownInput.current?.click()}
            >
              导入 Markdown
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  await editorApi.current?.flush();
                  const backup = await api<KnowledgeBackup>('/api/backups');
                  downloadText(
                    `dayzero-${new Date().toISOString().slice(0, 10)}.json`,
                    JSON.stringify(backup, null, 2),
                  );
                  setToast('完整备份已导出，不包含模型密钥');
                });
              }}
            >
              导出备份
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => backupInput.current?.click()}
            >
              恢复备份
            </button>
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  await editorApi.current?.flush();
                  setEditor(null);
                  setSettings(true);
                });
              }}
            >
              模型设置
            </button>
            <button
              className="new-knowledge"
              disabled={busy}
              onClick={() => {
                void create();
              }}
            >
              ＋ 新建知识点
            </button>
          </nav>
        </header>
        <input
          className="hidden-input"
          type="file"
          accept=".md,.markdown,text/markdown"
          ref={markdownInput}
          aria-label="导入 Markdown 文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void run(async () => {
              await editorApi.current?.flush();
              if (file.size > 1_100_000)
                throw new Error('Markdown 文件过大，请拆分后导入');
              const draft = await mutation<KnowledgeDraft>(
                '/api/import/markdown',
                {
                  filename: file.name,
                  text: await file.text(),
                  operationId: crypto.randomUUID(),
                },
              );
              await refresh();
              setTab('drafts');
              setSettings(false);
              setEditor({ kind: 'draft', id: draft.id });
              setToast('已导入为草稿，请审阅后确认入图');
            });
          }}
        />
        <input
          className="hidden-input"
          type="file"
          accept=".json,application/json"
          ref={backupInput}
          aria-label="恢复备份文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void run(async () => {
              await editorApi.current?.flush();
              if (file.size > 15_000_000)
                throw new Error('备份超过当前 15 MB 导入限制');
              let backup: KnowledgeBackup;
              try {
                backup = JSON.parse(await file.text());
              } catch {
                throw new Error('无法读取备份 JSON 文件');
              }
              const preview = await mutation<BackupPreview>(
                '/api/backups/preview',
                { backup },
              );
              setRestore({ backup, preview, operationId: crypto.randomUUID() });
            });
          }}
        />
        {error && (
          <div className="global-error" role="alert">
            {error}
            <button
              onClick={() => {
                void run(refresh);
              }}
            >
              重新加载
            </button>
            <button aria-label="关闭错误提示" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
        <main className="library-main">
          <section className="space-panel">
            <div className="space-header">
              <div>
                <p className="eyebrow">A SPACE FOR YOUR IDEAS</p>
                <h1>我的知识空间</h1>
                <p className="space-description">让每一份理解，都有迹可循。</p>
              </div>
              <span className="outline-tag">
                {loading ? '正在载入' : '个人知识库 · 本机保存'}
              </span>
            </div>
            <div className="canvas-wrap">
              <Space
                graph={graph}
                labels={activeNodes.map((node) => node.title)}
                mode={mode}
                onMode={setMode}
                selected={selected >= 0 ? selected : null}
                onSelect={(index) => {
                  const node = activeNodes[index];
                  if (node) void open({ kind: 'node', id: node.id });
                }}
                reset={reset}
                focus={focus}
                showEdges={showEdges}
                onMetrics={onMetrics}
              />
              {!loading && !activeNodes.length && (
                <div className="empty-space">
                  <span>✧</span>
                  <h2>从第一个知识点开始</h2>
                  <p>写下你的理解，确认后让它成为图谱中的一个点。</p>
                  <button
                    className="new-knowledge"
                    disabled={busy}
                    onClick={() => {
                      void create();
                    }}
                  >
                    新建知识点
                  </button>
                </div>
              )}
              {selectedNode && (
                <div className="selected-caption">
                  <span className="node-dot" />
                  <strong>{selectedNode.title}</strong>
                  <small>直接关联以蓝青色高亮</small>
                </div>
              )}
            </div>
            <div className="toolbar">
              <div className="segmented">
                <button
                  className={mode === 'orbit' ? 'selected' : ''}
                  aria-pressed={mode === 'orbit'}
                  onClick={() => setMode('orbit')}
                >
                  轨道观察
                </button>
                <button
                  className={mode === 'fly' ? 'selected' : ''}
                  aria-pressed={mode === 'fly'}
                  onClick={() => setMode('fly')}
                >
                  自由飞行
                </button>
              </div>
              <button
                className="quiet-button"
                onClick={() => {
                  setMode('orbit');
                  setFocus(null);
                  setReset((value) => value + 1);
                }}
              >
                ↗ 返回全景
              </button>
              {selected >= 0 && (
                <button
                  className="quiet-button"
                  onClick={() => {
                    setMode('orbit');
                    setFocus(selected);
                  }}
                >
                  定位选中节点
                </button>
              )}
              <label className="edge-toggle">
                <input
                  type="checkbox"
                  checked={showEdges}
                  onChange={(event) => setShowEdges(event.target.checked)}
                />
                显示关联
              </label>
            </div>
            <div className="navigation-hint">
              {mode === 'fly'
                ? '点击场景控制视角 · WASD 移动 / QE 上下 / Esc 退出'
                : '拖动旋转 / 右键平移 / 滚轮缩放 / 点击节点展开 Markdown'}
            </div>
            <div className="metrics">
              <div>
                <strong data-testid="knowledge-count">
                  {activeNodes.length}
                </strong>
                <span>知识点</span>
              </div>
              <div>
                <strong>{activeRelations.length}</strong>
                <span>已确认关联</span>
              </div>
              <div>
                <strong>{activeDrafts.length}</strong>
                <span>待入图草稿</span>
              </div>
              <div>
                <strong>
                  {metrics?.fps ?? '—'}
                  <em> FPS</em>
                </strong>
                <span>空间帧率</span>
              </div>
              <span className="metrics-label">
                YOUR OWN KNOWLEDGE <span className="live-dot" />
              </span>
            </div>
          </section>
          <aside className="inspector library-inspector">
            <div className="section-heading">
              <span>知识库</span>
              <span className="little-mark">◈</span>
            </div>
            <div className="search-box">
              <span>⌕</span>
              <input
                aria-label="搜索知识库"
                placeholder="标题、别名、正文或标签…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="library-tabs">
              <button
                className={tab === 'nodes' ? 'active' : ''}
                onClick={() => setTab('nodes')}
              >
                知识点 {activeNodes.length}
              </button>
              <button
                className={tab === 'drafts' ? 'active' : ''}
                onClick={() => setTab('drafts')}
              >
                草稿 {activeDrafts.length}
              </button>
              <button
                className={tab === 'trash' ? 'active' : ''}
                onClick={() => setTab('trash')}
              >
                回收站
              </button>
            </div>
            <div className="library-list">
              {visible.map((item) => {
                const kind = 'committedNodeId' in item ? 'draft' : 'node';
                return (
                  <div className="library-item" key={item.id}>
                    <button
                      className={
                        selectedId === item.id
                          ? 'library-item-button chosen'
                          : 'library-item-button'
                      }
                      onClick={() => {
                        void open({ kind, id: item.id });
                      }}
                    >
                      <span className="node-dot" />
                      <span>
                        <strong>{item.title || '未命名草稿'}</strong>
                        <small>
                          {item.tags.filter(Boolean).join(' · ') ||
                            (kind === 'draft'
                              ? '待确认入图'
                              : '独立知识或已确认关联')}
                        </small>
                      </span>
                      <span>↗</span>
                    </button>
                    {tab === 'trash' && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          void recover(kind, item);
                        }}
                      >
                        恢复
                      </button>
                    )}
                  </div>
                );
              })}
              {!loading && !visible.length && (
                <div className="list-empty">
                  {search
                    ? '没有匹配的内容'
                    : tab === 'drafts'
                      ? '还没有待处理草稿'
                      : tab === 'trash'
                        ? '回收站是空的'
                        : '你添加的知识会出现在这里'}
                </div>
              )}
              {tab === 'trash' && deletedRelations.length > 0 && (
                <section className="deleted-relations">
                  <h3>已删除的关联</h3>
                  {deletedRelations.map((edge) => (
                    <div key={edge.id}>
                      <p>
                        {
                          library.nodes.find(
                            (node) => node.id === edge.sourceId,
                          )?.title
                        }{' '}
                        ↔{' '}
                        {
                          library.nodes.find(
                            (node) => node.id === edge.targetId,
                          )?.title
                        }
                      </p>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          void recover('relation', edge);
                        }}
                      >
                        恢复关联
                      </button>
                    </div>
                  ))}
                </section>
              )}
            </div>
            <div className="library-footnote">
              <span
                className={`status-dot ${health?.status === 'ok' ? 'ready' : ''}`}
              />
              <span>
                {health?.status === 'ok'
                  ? '内容保存在本机数据库'
                  : '正在检查本机服务'}
              </span>
              <p>
                草稿经过你的明确确认后才会入图。当前配色用于浏览，语义自动归类将在后续开放。
              </p>
            </div>
          </aside>
        </main>
        <footer>
          <span>
            <span className="live-dot" /> PERSONAL KNOWLEDGE
          </span>
          <span>Dayzero / 每一份理解，都值得留下</span>
          <span>M2 / INGESTION</span>
        </footer>
      </div>
      {editor && editorRecord && (
        <Suspense
          fallback={<div className="editor-drawer">正在打开知识点…</div>}
        >
          <KnowledgeEditor
            key={`${editor.kind}:${editor.id}`}
            kind={editor.kind}
            record={editorRecord}
            library={library}
            onSaved={onSaved}
            onRefresh={refresh}
            onCommitted={committed}
            onClose={closeEditor}
            onTrash={trash}
            onOpenExisting={(id) => {
              void open({ kind: 'node', id });
            }}
            apiRef={editorApi}
          />
        </Suspense>
      )}
      {settings && (
        <Suspense fallback={<div className="editor-drawer">正在打开设置…</div>}>
          <ModelSettings onClose={() => setSettings(false)} />
        </Suspense>
      )}
      {restore && (
        <div className="modal-backdrop">
          <section
            className="restore-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="恢复备份确认"
          >
            <p className="eyebrow">RESTORE KNOWLEDGE</p>
            <h2>核对备份内容</h2>
            <p>
              {restore.preview.nodes} 个知识点 · {restore.preview.drafts} 个草稿
              · {restore.preview.relations} 条关系
            </p>
            <p className="muted">
              恢复会保留稳定
              ID、关系方向、历史版本和确认来源。模型配置和密钥不在备份范围内。
            </p>
            {!restore.preview.canRestore && (
              <div className="notice-banner">
                当前知识库已有内容。为避免覆盖，只能在新的空知识库中恢复。
              </div>
            )}
            <div className="form-actions">
              <button
                className="secondary-button"
                onClick={() => setRestore(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy || !restore.preview.canRestore}
                onClick={() => {
                  void run(async () => {
                    await mutation('/api/backups/restore', {
                      backup: restore.backup,
                      confirmed: true,
                      operationId: restore.operationId,
                    });
                    setRestore(null);
                    setEditor(null);
                    setSelectedId(null);
                    await refresh();
                    setToast('备份已恢复');
                  });
                }}
              >
                确认恢复备份
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
