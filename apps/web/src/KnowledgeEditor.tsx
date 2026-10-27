import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import {
  relationLabels,
  type DraftContent,
  type KnowledgeDraft,
  type KnowledgeNode,
  type KnowledgeRelation,
  type Library,
  type NodeHistory,
  type RelationType,
  type DraftLink,
  type KnowledgeEvent,
} from '@dayzero/contracts';
import MarkdownEditor from './MarkdownEditor.tsx';
import { api, downloadText, mutation, operationId } from './api.ts';

export type EditorHandle = { flush: () => Promise<void> };
export type Selection = { kind: 'node' | 'draft'; id: string };
type RecordValue = KnowledgeNode | KnowledgeDraft;
function formOf(record: RecordValue): DraftContent {
  return {
    title: record.title,
    markdown: record.markdown,
    aliases: record.aliases,
    tags: record.tags,
    sources: record.sources,
    links: 'links' in record ? record.links : [],
  };
}
const labels = relationLabels;
const time = (value: string) => new Date(value).toLocaleString('zh-CN');
export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: (props) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text || '*还没有正文。*'}
      </ReactMarkdown>
    </div>
  );
}

function LinkFields({
  value,
  onChange,
  nodes,
  prefix,
}: {
  value: DraftLink;
  onChange: (value: DraftLink) => void;
  nodes: KnowledgeNode[];
  prefix: string;
}) {
  const symmetric = ['related', 'contrast'].includes(value.type);
  return (
    <div className="link-fields">
      <label>
        目标知识点
        <select
          aria-label={`${prefix}目标知识点`}
          value={value.targetId}
          onChange={(event) =>
            onChange({ ...value, targetId: event.target.value })
          }
        >
          {!nodes.some((node) => node.id === value.targetId) && (
            <option value={value.targetId}>请选择有效知识点</option>
          )}
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
            </option>
          ))}
        </select>
      </label>
      <div className="form-columns">
        <label>
          关系类型
          <select
            aria-label={`${prefix}关系类型`}
            value={value.type}
            onChange={(event) =>
              onChange({ ...value, type: event.target.value as RelationType })
            }
          >
            {Object.entries(labels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          关系方向
          <select
            aria-label={`${prefix}关系方向`}
            value={value.direction}
            disabled={symmetric}
            onChange={(event) =>
              onChange({
                ...value,
                direction: event.target.value as DraftLink['direction'],
              })
            }
          >
            <option value="outgoing">当前知识点 → 目标</option>
            <option value="incoming">目标 → 当前知识点</option>
          </select>
        </label>
      </div>
      <label>
        关联说明
        <textarea
          aria-label={`${prefix}关联说明`}
          value={value.description}
          maxLength={5000}
          rows={2}
          onChange={(event) =>
            onChange({ ...value, description: event.target.value })
          }
        />
      </label>
    </div>
  );
}

export default function KnowledgeEditor({
  kind,
  record,
  library,
  onSaved,
  onRefresh,
  onCommitted,
  onClose,
  onTrash,
  apiRef,
}: {
  kind: Selection['kind'];
  record: RecordValue;
  library: Library;
  onSaved: (kind: Selection['kind'], value: RecordValue) => void;
  onRefresh: () => Promise<void>;
  onCommitted: (node: KnowledgeNode) => Promise<void>;
  onClose: () => Promise<void>;
  onTrash: (record: RecordValue, kind: Selection['kind']) => Promise<void>;
  apiRef: Ref<EditorHandle>;
}) {
  const [form, setForm] = useState(() => formOf(record));
  const formRef = useRef(form);
  formRef.current = form;
  const revision = useRef(record.revision);
  const persisted = useRef(JSON.stringify(formOf(record)));
  const saving = useRef<Promise<void> | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    'saved' | 'dirty' | 'saving' | 'error'
  >('saved');
  const [saveError, setSaveError] = useState(''),
    [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false),
    [tab, setTab] = useState<'preview' | 'edit'>(
      kind === 'draft' ? 'edit' : 'preview',
    );
  const [history, setHistory] = useState<NodeHistory | null>(null),
    [historyOpen, setHistoryOpen] = useState(false);
  const [deleteReview, setDeleteReview] = useState(false),
    [relationForm, setRelationForm] = useState<DraftLink | null>(null);
  const [editingRelation, setEditingRelation] =
      useState<KnowledgeRelation | null>(null),
    [relationHistory, setRelationHistory] = useState<KnowledgeEvent[] | null>(
      null,
    );
  const readOnly = Boolean(record.deletedAt);
  const activeNodes = library.nodes.filter(
    (node) => !node.deletedAt && node.id !== record.id,
  );
  const links = library.relations.filter(
    (edge) =>
      !edge.deletedAt &&
      (edge.sourceId === record.id || edge.targetId === record.id),
  );

  const flush = useCallback(async (): Promise<void> => {
    if (readOnly) return;
    if (saving.current) {
      await saving.current;
      return flush();
    }
    const snapshot = formRef.current,
      signature = JSON.stringify(snapshot);
    if (signature === persisted.current) return;
    setSaveStatus('saving');
    setSaveError('');
    const expectedRevision = revision.current;
    const { links: draftLinks, ...body } = snapshot;
    const promise = mutation<RecordValue>(
      `/api/${kind === 'draft' ? 'drafts' : 'nodes'}/${record.id}`,
      {
        ...body,
        ...(kind === 'draft' ? { links: draftLinks } : {}),
        expectedRevision,
        operationId: operationId(
          `save:${kind}:${record.id}:${expectedRevision}:${signature}`,
        ),
      },
      'PUT',
    )
      .then((value) => {
        revision.current = value.revision;
        persisted.current = signature;
        onSaved(kind, value);
        setSaveStatus(
          JSON.stringify(formRef.current) === signature ? 'saved' : 'dirty',
        );
      })
      .catch((error) => {
        setSaveStatus('error');
        setSaveError((error as Error).message);
        throw error;
      })
      .finally(() => {
        saving.current = null;
      });
    saving.current = promise;
    await promise;
    if (JSON.stringify(formRef.current) !== persisted.current) await flush();
  }, [kind, record.id, readOnly, onSaved]);
  useImperativeHandle(apiRef, () => ({ flush }), [flush]);
  useEffect(() => {
    if (readOnly || JSON.stringify(form) === persisted.current) return;
    setSaveStatus('dirty');
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 650);
    return () => clearTimeout(timer);
  }, [form, flush, readOnly]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        saving.current ||
        JSON.stringify(formRef.current) !== persisted.current
      )
        event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const update = (patch: Partial<DraftContent>) =>
    setForm((current) => ({ ...current, ...patch }));
  const loadLatest = async () => {
    setBusy(true);
    try {
      if (saving.current) await saving.current.catch(() => {});
      const latest = await api<Library>('/api/knowledge');
      const value = (kind === 'draft' ? latest.drafts : latest.nodes).find(
        (item) => item.id === record.id,
      );
      if (!value) throw new Error('未找到最新内容，请先下载本地副本。');
      downloadText(
        `dayzero-local-edit-${record.id}.json`,
        JSON.stringify(
          {
            id: record.id,
            kind,
            revision: revision.current,
            ...formRef.current,
          },
          null,
          2,
        ),
      );
      const next = formOf(value);
      revision.current = value.revision;
      persisted.current = JSON.stringify(next);
      formRef.current = next;
      setForm(next);
      onSaved(kind, value);
      setSaveStatus('saved');
      setSaveError('');
      setActionError('');
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError('');
    try {
      await flush();
      await fn();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const loadHistory = async () => {
    try {
      setHistory(await api<NodeHistory>(`/api/nodes/${record.id}/history`));
    } catch (error) {
      setActionError((error as Error).message);
    }
  };
  const applyVersion = (version: number) =>
    perform(async () => {
      const value = await mutation<KnowledgeNode>(
        `/api/nodes/${record.id}/restore-version`,
        {
          version,
          expectedRevision: revision.current,
          operationId: operationId(
            `version:${record.id}:${revision.current}:${version}`,
          ),
        },
      );
      const next = formOf(value);
      revision.current = value.revision;
      persisted.current = JSON.stringify(next);
      formRef.current = next;
      setForm(next);
      setSaveStatus('saved');
      onSaved('node', value);
      await loadHistory();
    });
  const saveRelation = () =>
    perform(async () => {
      if (!relationForm?.targetId) throw new Error('请选择目标知识点');
      const value = relationForm;
      const body = {
        sourceId: value.direction === 'outgoing' ? record.id : value.targetId,
        targetId: value.direction === 'outgoing' ? value.targetId : record.id,
        type: value.type,
        description: value.description,
        confirmed: true,
      };
      await mutation(
        `/api/relations${editingRelation ? `/${editingRelation.id}` : ''}`,
        {
          ...body,
          ...(editingRelation
            ? { expectedRevision: editingRelation.revision }
            : {}),
          operationId: operationId(
            `relation:${editingRelation?.id ?? record.id}:${editingRelation?.revision ?? ''}:${JSON.stringify(body)}`,
          ),
        },
        editingRelation ? 'PUT' : 'POST',
      );
      setRelationForm(null);
      setEditingRelation(null);
      await onRefresh();
    });
  return (
    <section className="editor-drawer" aria-label="知识编辑器">
      <header className="drawer-header">
        <div>
          <span className="eyebrow">
            {kind === 'draft'
              ? 'DRAFT / 草稿'
              : readOnly
                ? 'TRASH / 已删除'
                : 'KNOWLEDGE / 知识点'}
          </span>
          <h2>{record.title || '新的知识点'}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="关闭编辑器"
          disabled={busy}
          onClick={() => {
            void onClose();
          }}
        >
          ×
        </button>
      </header>
      <div className="editor-status">
        <span className={`save-state ${saveStatus}`} data-testid="save-status">
          {readOnly
            ? '回收站只读'
            : {
                saved: '已保存',
                dirty: '未保存',
                saving: '保存中…',
                error: '保存失败',
              }[saveStatus]}
        </span>
        <span>v{revision.current}</span>
      </div>
      {(saveError || actionError) && (
        <div className="error-banner" role="alert">
          {saveError || actionError}
          {saveError && (
            <>
              <button
                disabled={busy}
                onClick={() => {
                  void flush().catch(() => {});
                }}
              >
                重试保存
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  void loadLatest();
                }}
              >
                下载本地副本并载入最新版本
              </button>
            </>
          )}
        </div>
      )}
      <div className="editor-scroll">
        <label className="field-label">
          知识点标题
          <input
            aria-label="知识点标题"
            value={form.title}
            maxLength={200}
            disabled={readOnly}
            placeholder="为这个知识点起个名字"
            onChange={(event) => update({ title: event.target.value })}
          />
        </label>
        <details className="metadata-fields">
          <summary>
            别名、标签与来源 <span>{form.tags.join(' · ')}</span>
          </summary>
          <label>
            别名（逗号分隔）
            <input
              aria-label="知识点别名"
              disabled={readOnly}
              value={form.aliases.join(', ')}
              onChange={(event) =>
                update({
                  aliases: event.target.value
                    .split(/[,，]/)
                    .map((s) => s.trim()),
                })
              }
            />
          </label>
          <label>
            标签（逗号分隔）
            <input
              aria-label="知识点标签"
              disabled={readOnly}
              value={form.tags.join(', ')}
              onChange={(event) =>
                update({
                  tags: event.target.value.split(/[,，]/).map((s) => s.trim()),
                })
              }
            />
          </label>
          <label>
            来源（每行一条）
            <textarea
              aria-label="知识点来源"
              disabled={readOnly}
              value={form.sources.join('\n')}
              rows={2}
              onChange={(event) =>
                update({ sources: event.target.value.split('\n') })
              }
            />
          </label>
        </details>
        <div className="editor-tabs">
          <button
            className={tab === 'preview' ? 'active' : ''}
            onClick={() => setTab('preview')}
          >
            阅读预览
          </button>
          <button
            className={tab === 'edit' ? 'active' : ''}
            onClick={() => setTab('edit')}
          >
            编辑 Markdown
          </button>
        </div>
        {tab === 'edit' ? (
          <MarkdownEditor
            value={form.markdown}
            onChange={(markdown) => update({ markdown })}
            readOnly={readOnly}
          />
        ) : (
          <MarkdownPreview text={form.markdown} />
        )}

        {kind === 'draft' && !readOnly && (
          <section className="editor-section">
            <h3>
              手工关联 <small>可选</small>
            </h3>
            <p className="muted">
              选择已有知识点并检查关系。没有合适的关联，也可以独立加入图谱。
            </p>
            {form.links.map((link, index) => (
              <div className="link-card" key={index}>
                <div className="card-heading">
                  关联 {index + 1}
                  <button
                    className="text-button"
                    onClick={() =>
                      update({
                        links: form.links.filter((_, i) => i !== index),
                      })
                    }
                  >
                    移除
                  </button>
                </div>
                <LinkFields
                  prefix={`草稿关联${index + 1}`}
                  nodes={activeNodes}
                  value={link}
                  onChange={(value) =>
                    update({
                      links: form.links.map((item, i) =>
                        i === index ? value : item,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <button
              className="secondary-button"
              disabled={!activeNodes.length || form.links.length >= 30}
              onClick={() =>
                update({
                  links: [
                    ...form.links,
                    {
                      targetId: activeNodes[0]!.id,
                      type: 'related',
                      direction: 'outgoing',
                      description: '',
                    },
                  ],
                })
              }
            >
              ＋ 添加手工关联
            </button>
          </section>
        )}

        {kind === 'node' && (
          <section className="editor-section">
            <div className="card-heading">
              <h3>
                直接关联 <small>{links.length}</small>
              </h3>
              {!readOnly && (
                <button
                  className="text-button"
                  disabled={!activeNodes.length}
                  onClick={() => {
                    setEditingRelation(null);
                    setRelationForm({
                      targetId: activeNodes[0]!.id,
                      type: 'related',
                      direction: 'outgoing',
                      description: '',
                    });
                  }}
                >
                  ＋ 建立关联
                </button>
              )}
            </div>
            {!links.length && <p className="muted">这是一个独立的知识点。</p>}
            {links.map((edge) => {
              const otherId =
                edge.sourceId === record.id ? edge.targetId : edge.sourceId;
              const other = library.nodes.find((node) => node.id === otherId);
              const symmetric = ['related', 'contrast'].includes(edge.type);
              return (
                <div className="relation-row" key={edge.id}>
                  <strong>
                    {symmetric
                      ? `${labels[edge.type]} · ${other?.title}`
                      : edge.sourceId === record.id
                        ? `${labels[edge.type]} → ${other?.title}`
                        : `${other?.title} ${labels[edge.type]} → 当前知识点`}
                  </strong>
                  <p>{edge.description || '未填写关联说明'}</p>
                  <div className="row-actions">
                    <span>已人工确认 · v{edge.revision}</span>
                    <button
                      onClick={() => {
                        void api<KnowledgeEvent[]>(
                          `/api/relations/${edge.id}/history`,
                        )
                          .then(setRelationHistory)
                          .catch((error) => setActionError(error.message));
                      }}
                    >
                      历史
                    </button>
                    {!readOnly && (
                      <>
                        <button
                          onClick={() => {
                            setEditingRelation(edge);
                            setRelationForm({
                              targetId: otherId,
                              type: edge.type,
                              direction:
                                edge.sourceId === record.id
                                  ? 'outgoing'
                                  : 'incoming',
                              description: edge.description,
                            });
                          }}
                        >
                          修改
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            void perform(async () => {
                              await mutation(
                                `/api/relations/${edge.id}/delete`,
                                {
                                  expectedRevision: edge.revision,
                                  operationId: operationId(
                                    `delete-relation:${edge.id}:${edge.revision}`,
                                  ),
                                },
                              );
                              await onRefresh();
                            });
                          }}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {relationHistory && (
              <div className="history-panel">
                <button
                  className="text-button"
                  onClick={() => setRelationHistory(null)}
                >
                  关闭关联历史
                </button>
                {relationHistory.map((event) => (
                  <p key={event.id}>
                    {time(event.createdAt)} · {event.action}
                  </p>
                ))}
              </div>
            )}
            {relationForm && !readOnly && (
              <div className="link-card">
                <LinkFields
                  prefix="正式关联"
                  value={relationForm}
                  nodes={activeNodes}
                  onChange={setRelationForm}
                />
                <p className="muted">
                  请核对目标、类型与方向，确认后保存到图谱。
                </p>
                <div className="form-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setRelationForm(null);
                      setEditingRelation(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => {
                      void saveRelation();
                    }}
                  >
                    {editingRelation ? '确认修改关联' : '确认建立关联'}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {kind === 'node' && (
          <details
            className="editor-section"
            open={historyOpen}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setHistoryOpen(open);
              if (open) void loadHistory();
            }}
          >
            <summary>内容历史与版本恢复</summary>
            {history?.revisions.map((version) => (
              <div className="version-row" key={version.revision}>
                <div>
                  <strong>
                    v{version.revision} · {version.snapshot.title}
                  </strong>
                  <small>
                    {time(version.createdAt)} · {version.reason}
                  </small>
                </div>
                {!readOnly && (
                  <button
                    disabled={busy || version.revision === revision.current}
                    onClick={() => {
                      void applyVersion(version.revision);
                    }}
                  >
                    恢复此版本
                  </button>
                )}
                <details>
                  <summary>查看内容</summary>
                  <MarkdownPreview text={version.snapshot.markdown} />
                </details>
              </div>
            ))}
          </details>
        )}
        {!readOnly && (
          <section className="danger-section">
            <button
              className="text-button danger-text"
              onClick={() => setDeleteReview(!deleteReview)}
            >
              移入回收站
            </button>
            {deleteReview && (
              <div>
                <p>
                  此
                  {kind === 'draft'
                    ? '草稿'
                    : `知识点及其 ${links.length} 条直接关联`}
                  将隐藏，可在回收站恢复。
                </p>
                <button
                  className="secondary-button danger-text"
                  disabled={busy}
                  onClick={() => {
                    void perform(() =>
                      onTrash({ ...record, revision: revision.current }, kind),
                    );
                  }}
                >
                  确认移入回收站
                </button>
              </div>
            )}
          </section>
        )}
      </div>
      <footer className="drawer-footer">
        {kind === 'draft' && !readOnly ? (
          <>
            <span>将创建 1 个知识点、{form.links.length} 条关联</span>
            <button
              className="primary-button"
              disabled={busy || !form.title.trim()}
              onClick={() => {
                void perform(async () => {
                  const result = await mutation<{ node: KnowledgeNode }>(
                    `/api/drafts/${record.id}/commit`,
                    {
                      expectedRevision: revision.current,
                      confirmed: true,
                      operationId: operationId(
                        `commit:${record.id}:${revision.current}`,
                      ),
                    },
                  );
                  await onCommitted(result.node);
                });
              }}
            >
              确认加入图谱 ↗
            </button>
          </>
        ) : (
          <>
            <span>{readOnly ? '恢复后可继续编辑' : '更改会自动保存'}</span>
            {kind === 'node' && (
              <a
                className="secondary-button"
                href={`/api/nodes/${record.id}/markdown`}
              >
                导出 Markdown
              </a>
            )}
          </>
        )}
      </footer>
    </section>
  );
}
