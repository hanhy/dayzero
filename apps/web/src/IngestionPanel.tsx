import { useEffect, useRef, useState } from 'react';
import {
  relationLabels,
  type DraftLink,
  type IngestionRun,
  type KnowledgeDraft,
  type KnowledgeNode,
  type Library,
  type ModelProfile,
  type RelationType,
} from '@dayzero/contracts';
import { api, mutation, operationId } from './api.ts';
const stages: Record<string, string> = {
  queued: '等待后台处理',
  parse: '解析知识点',
  match: '匹配已有知识',
  suggest: '生成关联建议',
  review: '等待审阅',
  commit: '正在加入图谱',
  committed: '已加入图谱',
};
export default function IngestionPanel({
  draftId,
  library,
  flush,
  onCommitted,
  onOpenExisting,
  onActiveChange,
}: {
  draftId: string;
  library: Library;
  flush: () => Promise<void>;
  onCommitted: (node: KnowledgeNode) => Promise<void>;
  onOpenExisting: (id: string) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [models, setModels] = useState<ModelProfile[]>([]),
    [chat, setChat] = useState(''),
    [embedding, setEmbedding] = useState('');
  const [run, setRun] = useState<IngestionRun | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({}),
    [edited, setEdited] = useState<Record<string, DraftLink>>({}),
    [manual, setManual] = useState<(DraftLink & { targetRevision?: number })[]>(
      [],
    ),
    [independent, setIndependent] = useState(false);
  const loaded = useRef(''),
    handled = useRef('');
  const currentRun = useRef<IngestionRun | null>(null);
  const acceptRun = (value: IngestionRun | null) => {
    const current = currentRun.current;
    if (
      current &&
      (!value ||
        value.createdAt < current.createdAt ||
        (value.id === current.id &&
          (value.reviewVersion < current.reviewVersion ||
            value.updatedAt < current.updatedAt)))
    )
      return;
    currentRun.current = value;
    setRun(value);
    setLoading(false);
    const signature = value
      ? `${value.id}:${value.reviewVersion}:${value.parsed ? 'parsed' : ''}:${value.proposals?.map((p) => p.id).join(',') ?? ''}`
      : '';
    if (signature !== loaded.current) {
      loaded.current = signature;
      if (value) {
        setChat(value.chatProfileId);
        setEmbedding(value.embeddingProfileId);
      }
      setDecisions(
        Object.fromEntries(
          value?.decision?.decisions.map((d) => [d.proposalId, d.accepted]) ??
            [],
        ),
      );
      setEdited(
        Object.fromEntries(
          (value?.proposals ?? []).map((p) => [
            p.id,
            value?.decision?.links.find(
              (l) =>
                l.proposalId === p.id ||
                (!('proposalId' in l && l.proposalId) &&
                  l.targetId === p.targetId),
            ) ?? p,
          ]),
        ),
      );
      setManual(
        (
          value?.decision?.links ??
          library.drafts.find((d) => d.id === draftId)?.links ??
          []
        ).filter(
          (l) =>
            !('proposalId' in l && l.proposalId) &&
            !value?.decision?.decisions.some(
              (d) =>
                d.accepted &&
                value.proposals?.some(
                  (p) => p.id === d.proposalId && p.targetId === l.targetId,
                ),
            ),
        ),
      );
      setIndependent(value?.decision?.independent ?? false);
    }
  };
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const value = await api<IngestionRun | null>(
          `/api/drafts/${draftId}/ingestion`,
        );
        if (alive) acceptRun(value);
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };
    void api<{ profiles: ModelProfile[] }>('/api/models')
      .then((result) => {
        if (!alive) return;
        setModels(result.profiles);
        setChat(
          currentRun.current?.chatProfileId ??
            result.profiles.find((p) => p.purpose === 'chat')?.id ??
            '',
        );
        setEmbedding(
          currentRun.current?.embeddingProfileId ??
            result.profiles.find((p) => p.purpose === 'embedding')?.id ??
            '',
        );
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [draftId]);
  useEffect(() => {
    if (
      run?.status === 'committed' &&
      run.resultNodeId &&
      handled.current !== run.id
    ) {
      handled.current = run.id;
      void api<Library>('/api/knowledge')
        .then((result) => {
          const node = result.nodes.find((n) => n.id === run.resultNodeId);
          if (node) return onCommitted(node);
        })
        .catch((e) => {
          handled.current = '';
          setError(e.message);
        });
    }
  }, [run, onCommitted]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    await flush();
    const current = (await api<Library>('/api/knowledge')).drafts.find(
      (d) => d.id === draftId,
    ) as KnowledgeDraft;
    if (!current) throw new Error('草稿不存在');
    acceptRun(
      await mutation<IngestionRun>(`/api/drafts/${draftId}/analyze`, {
        operationId: operationId(
          `analyze:${draftId}:${current.revision}:${chat}:${embedding}:${run?.id ?? ''}`,
        ),
        expectedRevision: current.revision,
        chatProfileId: chat,
        embeddingProfileId: embedding,
      }),
    );
  };
  const proposals = run?.proposals ?? [];
  const accepted = proposals
    .filter((p) => decisions[p.id] === true)
    .map((p) => {
      const value = edited[p.id] ?? p;
      return {
        targetId: value.targetId,
        type: value.type,
        direction: value.direction,
        description: value.description,
        proposalId: p.id,
        targetRevision: run!.candidates!.find((c) => c.targetId === p.targetId)!
          .revision,
      };
    });
  const links = [
    ...accepted,
    ...manual.map((l) => ({
      ...l,
      targetRevision:
        l.targetRevision ??
        library.nodes.find((n) => n.id === l.targetId)?.revision ??
        0,
    })),
  ];
  const allReviewed = proposals.every((p) => decisions[p.id] !== undefined);
  const editable = run?.status === 'review';
  const active =
    run && ['queued', 'processing', 'committing'].includes(run.status);
  useEffect(() => {
    onActiveChange(loading || Boolean(active) || run?.status === 'review');
  }, [loading, active, run?.status, onActiveChange]);
  const linkFields = (
    value: DraftLink,
    onChange: (value: DraftLink) => void,
  ) => (
    <div className="ai-link-fields">
      <label>
        类型
        <select
          aria-label="建议关系类型"
          disabled={!editable || busy}
          value={value.type}
          onChange={(e) =>
            onChange({ ...value, type: e.target.value as RelationType })
          }
        >
          {Object.entries(relationLabels).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        方向
        <select
          aria-label="建议关系方向"
          disabled={
            !editable || busy || ['related', 'contrast'].includes(value.type)
          }
          value={value.direction}
          onChange={(e) =>
            onChange({
              ...value,
              direction: e.target.value as DraftLink['direction'],
            })
          }
        >
          <option value="outgoing">当前知识 → 目标</option>
          <option value="incoming">目标 → 当前知识</option>
        </select>
      </label>
      <label>
        说明
        <textarea
          aria-label="建议关联说明"
          disabled={!editable || busy}
          value={value.description}
          maxLength={5000}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </label>
    </div>
  );
  return (
    <section className="editor-section ai-ingestion" aria-label="AI 录入工作流">
      <h3>AI 录入工作流</h3>
      <p className="muted">
        解析 → 匹配 → 建议 → 你来确认 →
        入图。初次分析会为已有知识生成向量，内容将发送至你选择的模型服务。
      </p>
      {loading ? (
        <p>正在恢复任务…</p>
      ) : (
        <>
          {(!run || ['cancelled', 'stale', 'failed'].includes(run.status)) && (
            <div className="ai-model-picker">
              <label>
                对话模型
                <select
                  aria-label="分析对话模型"
                  value={chat}
                  onChange={(e) => setChat(e.target.value)}
                >
                  <option value="">请选择</option>
                  {models
                    .filter((p) => p.purpose === 'chat')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                向量模型
                <select
                  aria-label="分析向量模型"
                  value={embedding}
                  onChange={(e) => setEmbedding(e.target.value)}
                >
                  <option value="">请选择</option>
                  {models
                    .filter((p) => p.purpose === 'embedding')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              {(!chat || !embedding) && (
                <p className="notice-banner">
                  请先在「模型设置」保存对话和向量模型，并分别测试连接。
                </p>
              )}
              <button
                className="secondary-button"
                disabled={busy || !chat || !embedding}
                onClick={() => void perform(start)}
              >
                开始 AI 分析
              </button>
            </div>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {run && (
            <>
              <p className="ai-stage" role="status">
                {run.status === 'failed'
                  ? '分析失败'
                  : run.status === 'cancelled'
                    ? '已取消'
                    : run.status === 'stale'
                      ? '需要重新分析'
                      : (stages[run.stage] ?? run.stage)}
                {active && '…'}
              </p>
              {run.progress.total !== undefined && (
                <small>
                  向量索引 {run.progress.indexed ?? 0} / {run.progress.total}
                </small>
              )}
              {run.error && <p className="notice-banner">{run.error}</p>}
              {run.calls?.[0] && (
                <p className="muted">
                  模型调用 {run.calls[0].count} 次 · 累计{' '}
                  {run.calls[0].durationMs} ms
                </p>
              )}
              {run.parsed && (
                <details open>
                  <summary>概念解释</summary>
                  <p>{run.parsed.summary}</p>
                </details>
              )}
              {run.candidates && (
                <details open>
                  <summary>内容匹配 · {run.candidates.length}</summary>
                  {!run.candidates.length && (
                    <p className="muted">
                      没有合适匹配，可审阅后作为独立知识点加入。
                    </p>
                  )}
                  {run.candidates.map((c) => (
                    <div className="ai-candidate" key={c.targetId}>
                      <strong>
                        {c.title}{' '}
                        {c.duplicate && (
                          <span className="duplicate-badge">疑似重复</span>
                        )}
                      </strong>
                      <p>{c.reason ?? '等待匹配解释'}</p>
                      <small>
                        {c.level
                          ? { high: '高', medium: '中', low: '低' }[c.level]
                          : '待分析'}
                        匹配 ·{' '}
                        {c.matchedBy
                          .map((s) => (s === 'vector' ? '向量' : '关键词'))
                          .join(' + ')}{' '}
                        · 第 {c.startLine}–{c.endLine} 行
                      </small>
                      <blockquote>{c.excerpt}</blockquote>
                      <button
                        className="text-button"
                        onClick={() => onOpenExisting(c.targetId)}
                      >
                        查看已有知识
                      </button>
                    </div>
                  ))}
                </details>
              )}
              {editable && (
                <>
                  <h4>逐条决定关联</h4>
                  {proposals.map((p) => (
                    <div className="ai-proposal" key={p.id}>
                      <strong>
                        {
                          run.candidates?.find((c) => c.targetId === p.targetId)
                            ?.title
                        }
                      </strong>
                      <small>
                        {p.confidence === 'tentative'
                          ? '待核实推测'
                          : '有片段依据'}
                        ，请自行复核
                      </small>
                      <p>草稿依据：「{p.draftQuote}」</p>
                      <p>目标依据：「{p.targetQuote}」</p>
                      {linkFields(edited[p.id] ?? p, (value) =>
                        setEdited((current) => ({ ...current, [p.id]: value })),
                      )}
                      <div className="form-actions">
                        <button
                          className={
                            decisions[p.id] === true
                              ? 'primary-button'
                              : 'secondary-button'
                          }
                          disabled={busy}
                          onClick={() =>
                            setDecisions((d) => ({ ...d, [p.id]: true }))
                          }
                        >
                          接受建议
                        </button>
                        <button
                          className={
                            decisions[p.id] === false
                              ? 'primary-button'
                              : 'secondary-button'
                          }
                          disabled={busy}
                          onClick={() =>
                            setDecisions((d) => ({ ...d, [p.id]: false }))
                          }
                        >
                          拒绝建议
                        </button>
                      </div>
                    </div>
                  ))}
                  <h4>手工补充</h4>
                  {manual.map((link, index) => (
                    <div className="ai-proposal" key={index}>
                      <select
                        aria-label="AI 审阅手工目标"
                        value={link.targetId}
                        onChange={(e) =>
                          setManual((items) =>
                            items.map((v, i) =>
                              i === index
                                ? { ...v, targetId: e.target.value }
                                : v,
                            ),
                          )
                        }
                      >
                        {library.nodes
                          .filter((n) => !n.deletedAt)
                          .map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.title}
                            </option>
                          ))}
                      </select>
                      {linkFields(link, (value) =>
                        setManual((items) =>
                          items.map((v, i) => (i === index ? value : v)),
                        ),
                      )}
                      <button
                        className="text-button"
                        onClick={() =>
                          setManual((items) =>
                            items.filter((_, i) => i !== index),
                          )
                        }
                      >
                        移除补充关联
                      </button>
                    </div>
                  ))}
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      !library.nodes.some((n) => !n.deletedAt) ||
                      links.length >= 30
                    }
                    onClick={() =>
                      setManual((items) => [
                        ...items,
                        {
                          targetId: library.nodes.find((n) => !n.deletedAt)!.id,
                          type: 'related',
                          direction: 'outgoing',
                          description: '',
                        },
                      ])
                    }
                  >
                    ＋ 手工补充关联
                  </button>
                  <label className="checkbox-label">
                    <input
                      aria-label="确认独立新增"
                      type="checkbox"
                      checked={independent}
                      onChange={(e) => setIndependent(e.target.checked)}
                    />
                    确认创建新的独立知识点，不合并已有节点（无关联或疑似重复时必选）
                  </label>
                  <p>最终清单：新建 1 个知识点、{links.length} 条关联。</p>
                  <div className="form-actions">
                    <button
                      className="secondary-button"
                      disabled={busy || !allReviewed}
                      onClick={() =>
                        void perform(async () => {
                          await flush();
                          acceptRun(
                            await mutation<IngestionRun>(
                              `/api/ingestion/${run.id}/review`,
                              {
                                operationId: operationId(
                                  `review:${run.id}:${run.reviewVersion}:${JSON.stringify({ links, decisions, independent })}`,
                                ),
                                expectedReviewVersion: run.reviewVersion,
                                links,
                                decisions: proposals.map((p) => ({
                                  proposalId: p.id,
                                  accepted: decisions[p.id] === true,
                                })),
                                independent,
                              },
                              'PUT',
                            ),
                          );
                        })
                      }
                    >
                      保存审阅决定
                    </button>
                    <button
                      className="primary-button"
                      disabled={
                        busy ||
                        !allReviewed ||
                        (!links.length && !independent) ||
                        ((run.candidates ?? []).some((c) => c.duplicate) &&
                          !independent)
                      }
                      onClick={() =>
                        void perform(async () => {
                          await flush();
                          const saved = await mutation<IngestionRun>(
                            `/api/ingestion/${run.id}/review`,
                            {
                              operationId: operationId(
                                `review:${run.id}:${run.reviewVersion}:${JSON.stringify({ links, decisions, independent })}`,
                              ),
                              expectedReviewVersion: run.reviewVersion,
                              links,
                              decisions: proposals.map((p) => ({
                                proposalId: p.id,
                                accepted: decisions[p.id] === true,
                              })),
                              independent,
                            },
                            'PUT',
                          );
                          acceptRun(
                            await mutation<IngestionRun>(
                              `/api/ingestion/${run.id}/confirm`,
                              {
                                expectedReviewVersion: saved.reviewVersion,
                                confirmed: true,
                              },
                            ),
                          );
                        })
                      }
                    >
                      确认 AI 审阅并入图
                    </button>
                  </div>
                  <p className="muted">
                    重新分析当前草稿，生成的新建议需要重新审阅。
                  </p>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await flush();
                        acceptRun(
                          await mutation<IngestionRun>(
                            `/api/ingestion/${run.id}/cancel`,
                            {},
                          ),
                        );
                        await start();
                      })
                    }
                  >
                    重新生成
                  </button>
                </>
              )}
              {run.status === 'failed' && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      acceptRun(
                        await mutation<IngestionRun>(
                          `/api/ingestion/${run.id}/retry`,
                          {},
                        ),
                      ),
                    )
                  }
                >
                  重试当前任务
                </button>
              )}
              {!['committed', 'cancelled', 'stale'].includes(run.status) && (
                <button
                  className="text-button danger-text"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      acceptRun(
                        await mutation<IngestionRun>(
                          `/api/ingestion/${run.id}/cancel`,
                          {},
                        ),
                      ),
                    )
                  }
                >
                  取消 AI 任务
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
