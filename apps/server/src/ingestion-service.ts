import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  IngestionRun,
  IngestionReview,
  KnowledgeDraft,
  ParsedKnowledge,
  MatchCandidate,
  RelationProposal,
  ModelAnalysis,
} from '@dayzero/contracts';
import { ParsedSchema, AnalysisSchema } from '@dayzero/contracts';
import { KnowledgeService, ApiError, rows } from './knowledge-service.ts';
import { ModelProfiles } from './model-profiles.ts';
import { ModelGateway } from './model-gateway.ts';
import { retrieve } from './retrieval.ts';

const fields = `id,draft_id AS "draftId",draft_revision AS "draftRevision",workflow_version AS "workflowVersion",chat_profile_id AS "chatProfileId",embedding_profile_id AS "embeddingProfileId",chat_version AS "chatVersion",embedding_version AS "embeddingVersion",status,stage,parsed,candidates,proposals,decision,review_version AS "reviewVersion",result_node_id AS "resultNodeId",error,progress,created_at AS "createdAt",updated_at AS "updatedAt"`;
export type StoredRun = IngestionRun & {
  chatVersion: string;
  embeddingVersion: string;
};
export class IngestionService {
  knowledge: KnowledgeService;
  models: ModelProfiles;
  gateway: ModelGateway;
  constructor(
    public pool: Pool,
    masterKey?: string,
  ) {
    this.knowledge = new KnowledgeService(pool);
    this.models = new ModelProfiles(pool, masterKey);
    this.gateway = new ModelGateway(pool, this.models);
  }
  async raw(id: string, client: Pick<Pool, 'query'> = this.pool) {
    const [run] = await rows<StoredRun>(
      client,
      `SELECT ${fields} FROM knowledge.ingestion_runs WHERE id=$1`,
      [id],
    );
    if (!run) throw new ApiError(404, '录入任务不存在');
    return run;
  }
  async get(id: string) {
    const run = await this.raw(id);
    if (!['committed', 'cancelled', 'stale'].includes(run.status)) {
      const draft = await this.knowledge.draft(this.pool, run.draftId);
      if (
        draft.revision !== run.draftRevision ||
        draft.deletedAt ||
        draft.committedNodeId
      )
        return {
          ...run,
          status: 'stale' as const,
          error: '草稿内容已改变，请重新分析',
        };
    }
    const calls = await rows<{
      count: number;
      durationMs: number;
      usage: unknown[];
    }>(
      this.pool,
      `SELECT count(*)::int AS count,coalesce(sum(duration_ms),0)::int AS "durationMs",coalesce(jsonb_agg(usage) FILTER (WHERE usage IS NOT NULL),'[]') AS usage FROM knowledge.model_calls WHERE run_id=$1`,
      [id],
    );
    return { ...run, calls };
  }
  async latest(draftId: string) {
    const result = await this.pool.query(
      'SELECT id FROM knowledge.ingestion_runs WHERE draft_id=$1 ORDER BY created_at DESC LIMIT 1',
      [draftId],
    );
    return result.rows[0] ? this.get(result.rows[0].id) : null;
  }
  async start(
    draftId: string,
    input: {
      operationId: string;
      expectedRevision: number;
      chatProfileId: string;
      embeddingProfileId: string;
    },
  ) {
    const chat = await this.models.connection(input.chatProfileId, 'chat'),
      embedding = await this.models.connection(
        input.embeddingProfileId,
        'embedding',
      );
    return this.knowledge.mutate(
      'ingestion.start',
      input.operationId,
      { draftId, ...input },
      async (client) => {
        const draft = await this.knowledge.draft(client, draftId);
        if (
          draft.revision !== input.expectedRevision ||
          draft.deletedAt ||
          draft.committedNodeId
        )
          throw new ApiError(409, '草稿已改变或不可分析，请重新载入');
        if (!draft.title.trim()) throw new ApiError(400, '请先填写知识点标题');
        if (draft.markdown.length > 60000)
          throw new ApiError(
            400,
            '单次 AI 分析最多支持 6 万字符，请精简草稿或使用人工录入',
          );
        await client.query(
          "UPDATE knowledge.ingestion_runs SET status='stale',error='草稿已修改',updated_at=now() WHERE draft_id=$1 AND draft_revision<>$2 AND status IN ('queued','processing','review','committing')",
          [draftId, draft.revision],
        );
        if (
          (
            await client.query(
              "SELECT 1 FROM knowledge.ingestion_runs WHERE draft_id=$1 AND status IN ('queued','processing','review','committing')",
              [draftId],
            )
          ).rowCount
        )
          throw new ApiError(409, '已有进行中的分析，请先继续或取消');
        await client.query(
          `INSERT INTO knowledge.ingestion_runs(id,draft_id,draft_revision,chat_profile_id,embedding_profile_id,chat_version,embedding_version,commit_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            input.operationId,
            draftId,
            draft.revision,
            chat.id,
            embedding.id,
            chat.version,
            embedding.version,
            randomUUID(),
          ],
        );
        return this.raw(input.operationId, client);
      },
    );
  }
  async guard(id: string) {
    const run = await this.raw(id);
    if (['cancelled', 'stale'].includes(run.status))
      throw new ApiError(409, '任务已取消或需要重新分析');
    const draft = await this.knowledge.draft(this.pool, run.draftId);
    if (
      draft.revision !== run.draftRevision ||
      draft.deletedAt ||
      draft.committedNodeId
    )
      throw new ApiError(409, '草稿内容已改变，请重新分析');
    const chat = await this.models.connection(run.chatProfileId, 'chat'),
      embedding = await this.models.connection(
        run.embeddingProfileId,
        'embedding',
      );
    if (
      chat.version !== run.chatVersion ||
      embedding.version !== run.embeddingVersion
    )
      throw new ApiError(409, '模型配置已改变，请取消旧任务并重新分析');
    return { run, draft, chat, embedding };
  }
  async review(id: string, input: IngestionReview) {
    return this.knowledge.mutate(
      'ingestion.review',
      input.operationId,
      { id, ...input },
      async (client) => {
        const run = await this.raw(id, client);
        if (
          run.status !== 'review' ||
          run.reviewVersion !== input.expectedReviewVersion
        )
          throw new ApiError(409, '审阅版本已更新或任务不在待确认状态');
        await this.validateDraftAndTargets(client, run, input);
        const ids = new Set((run.proposals ?? []).map((p) => p.id));
        if (
          input.decisions.length !== ids.size ||
          new Set(input.decisions.map((d) => d.proposalId)).size !== ids.size ||
          input.decisions.some((d) => !ids.has(d.proposalId))
        )
          throw new ApiError(400, '请逐条审阅所有关联建议');
        for (const decision of input.decisions)
          if (
            decision.accepted &&
            !input.links.some(
              (link) =>
                link.targetId ===
                run.proposals!.find((p) => p.id === decision.proposalId)!
                  .targetId,
            )
          )
            throw new ApiError(400, '接受的建议需要保留在最终关联清单中');
        await client.query(
          'UPDATE knowledge.ingestion_runs SET decision=$2,review_version=review_version+1,updated_at=now() WHERE id=$1',
          [id, JSON.stringify({ ...input, id: randomUUID() })],
        );
        return this.raw(id, client);
      },
    );
  }
  async validateDraftAndTargets(
    client: Pick<PoolClient, 'query'>,
    run: StoredRun,
    decision: IngestionReview,
  ) {
    const draft = await this.knowledge.draft(client, run.draftId);
    if (
      draft.deletedAt ||
      draft.committedNodeId ||
      draft.revision !== run.draftRevision
    )
      throw new ApiError(409, '草稿已修改，旧分析与确认已失效，请重新分析');
    const unique = new Set<string>();
    for (const link of decision.links) {
      if (
        link.proposalId &&
        !decision.decisions.some(
          (d) => d.proposalId === link.proposalId && d.accepted,
        )
      )
        throw new ApiError(400, '关联与人工建议决定不一致');
      const key = `${link.targetId}:${link.type}:${['related', 'contrast'].includes(link.type) ? 'symmetric' : link.direction}`;
      if (unique.has(key))
        throw new ApiError(400, '最终清单存在重复关联，请合并后再确认');
      unique.add(key);
      const snapshot = run.candidates?.find(
        (candidate) => candidate.targetId === link.targetId,
      );
      if (snapshot && snapshot.revision !== link.targetRevision)
        throw new ApiError(409, '候选分析版本已失效，请重新分析');
      const target = await this.knowledge.node(client, link.targetId);
      if (target.deletedAt || target.revision !== link.targetRevision)
        throw new ApiError(409, '目标知识点已修改或删除，请重新分析并复核关联');
    }
  }
  async confirm(id: string, expected: number) {
    const hash = createHash('sha256')
      .update(`confirm:${id}:${expected}`)
      .digest('hex');
    const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    return this.knowledge.mutate(
      'ingestion.confirm',
      operationId,
      { id, expected },
      async (client) => {
        const run = await this.raw(id, client);
        if (
          run.status !== 'review' ||
          run.reviewVersion !== expected ||
          !run.decision
        )
          throw new ApiError(409, '请先保存当前审阅决定');
        await this.validateDraftAndTargets(client, run, run.decision);
        if (
          (!run.decision.links.length ||
            (run.candidates ?? []).some((c) => c.duplicate)) &&
          !run.decision.independent
        )
          throw new ApiError(400, '请明确确认作为独立的新知识点加入');
        await client.query(
          "UPDATE knowledge.ingestion_runs SET status='queued',stage='commit',error=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
        return this.raw(id, client);
      },
    );
  }
  async cancel(id: string) {
    return this.knowledge.mutate(
      'ingestion.cancel',
      randomUUID(),
      { id },
      async (client) => {
        const run = await this.raw(id, client);
        if (run.status === 'committed')
          throw new ApiError(
            409,
            '任务已经入图，请通过知识点回收站撤销并检查关联影响',
          );
        await client.query(
          "UPDATE knowledge.ingestion_runs SET status='cancelled',updated_at=now() WHERE id=$1",
          [id],
        );
        return this.raw(id, client);
      },
    );
  }
  async retry(id: string) {
    await this.guard(id);
    return this.knowledge.mutate(
      'ingestion.retry',
      randomUUID(),
      { id },
      async (client) => {
        const run = await this.raw(id, client);
        if (run.status !== 'failed')
          throw new ApiError(409, '只有失败任务可以重试');
        await client.query(
          "UPDATE knowledge.ingestion_runs SET status='queued',error=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
        return this.raw(id, client);
      },
    );
  }
  async phase(id: string, stage: string) {
    await this.guard(id);
    await this.pool.query(
      "UPDATE knowledge.ingestion_runs SET stage=$2,status='processing',updated_at=now() WHERE id=$1 AND status NOT IN ('cancelled','stale','committed')",
      [id, stage],
    );
  }
  async step<T>(
    id: string,
    name: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ) {
    await this.guard(id);
    signal.throwIfAborted();
    const cached = await this.pool.query(
      'SELECT result FROM knowledge.ingestion_steps WHERE run_id=$1 AND step=$2',
      [id, name],
    );
    if (cached.rows[0]) return cached.rows[0].result as T;
    const result = await fn();
    await this.guard(id);
    signal.throwIfAborted();
    await this.pool.query(
      'INSERT INTO knowledge.ingestion_steps(run_id,step,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, name, JSON.stringify(result)],
    );
    return result;
  }
  async parse(id: string, signal: AbortSignal) {
    await this.phase(id, 'parse');
    const { draft, chat } = await this.guard(id);
    const parsed = await this.step<ParsedKnowledge>(id, 'parse', signal, () =>
      this.gateway.structured(
        chat,
        ParsedSchema,
        '请用简单的语言直接回答这个概念是什么，先给出定义，可补充一个简短例子。summary 填概念解释，coreConcept 填概念名称。即使笔记只有标题也直接解释概念，不描述笔记内容或评价其完整性，不列待澄清事项或拆分建议。',
        {
          question: `${draft.title.replace(/^#+\s*/, '').trim()}是什么？请用简单的方式介绍它的概念。`,
          title: draft.title,
          markdown: draft.markdown,
          aliases: draft.aliases,
        },
        { runId: id, signal, purpose: 'parse' },
      ),
    );
    await this.pool.query(
      'UPDATE knowledge.ingestion_runs SET parsed=$2 WHERE id=$1',
      [id, JSON.stringify(parsed)],
    );
  }
  async match(id: string, signal: AbortSignal) {
    await this.phase(id, 'match');
    const { draft, embedding } = await this.guard(id);
    const candidates = await this.step<MatchCandidate[]>(
      id,
      'match',
      signal,
      () =>
        retrieve(
          this.pool,
          this.gateway,
          embedding,
          draft,
          id,
          signal,
          async (done, total) => {
            await this.pool.query(
              'UPDATE knowledge.ingestion_runs SET progress=$2,updated_at=now() WHERE id=$1',
              [id, { indexed: done, total }],
            );
          },
        ),
    );
    await this.pool.query(
      'UPDATE knowledge.ingestion_runs SET candidates=$2 WHERE id=$1',
      [id, JSON.stringify(candidates)],
    );
  }
  async suggest(id: string, signal: AbortSignal) {
    await this.phase(id, 'suggest');
    const { run, draft, chat } = await this.guard(id);
    const candidates = run.candidates ?? [];
    const analysis = await this.step<ModelAnalysis>(
      id,
      'suggest',
      signal,
      async () => {
        if (!candidates.length) return { matches: [], proposals: [] };
        return this.gateway.structured<ModelAnalysis>(
          chat,
          AnalysisSchema,
          '分别解释内容匹配程度和是否值得连线。每个候选都要给出匹配解释。疑似重复明确标记 duplicate。最多建议5条关系，不必强行关联。draftQuote 必须逐字出自草稿正文，targetQuote 必须逐字出自候选 excerpt；依据薄弱用 tentative。prerequisite 表示起点是终点的前置知识，part_of 表示起点属于终点，used_for 表示起点用于终点。',
          {
            draft: { title: draft.title, markdown: draft.markdown },
            parsed: run.parsed,
            candidates,
          },
          { runId: id, signal, purpose: 'suggest' },
          (value) => {
            const allowed = new Map(candidates.map((c) => [c.targetId, c]));
            if (
              value.matches.length !== allowed.size ||
              new Set(value.matches.map((m) => m.targetId)).size !==
                allowed.size ||
              value.matches.some((m) => !allowed.has(m.targetId))
            )
              throw new Error('matches');
            const unique = new Set<string>();
            for (const proposal of value.proposals) {
              const target = allowed.get(proposal.targetId);
              if (
                !target ||
                !draft.markdown.includes(proposal.draftQuote) ||
                !target.excerpt.includes(proposal.targetQuote)
              )
                throw new Error('evidence');
              const key = `${proposal.targetId}:${proposal.type}:${proposal.direction}`;
              if (unique.has(key)) throw new Error('duplicate');
              unique.add(key);
            }
          },
        );
      },
    );
    const merged = candidates.map((c) => ({
      ...c,
      ...analysis.matches.find((m) => m.targetId === c.targetId),
    }));
    const proposals = analysis.proposals.map((p) => ({
      ...p,
      id: randomUUID(),
    }));
    // Keep proposal IDs stable if this completed step is replayed.
    const saved = await this.pool.query(
      'SELECT result FROM knowledge.ingestion_steps WHERE run_id=$1 AND step=$2',
      [id, 'proposal-ids'],
    );
    const stable: RelationProposal[] = saved.rows[0]?.result ?? proposals;
    await this.pool.query(
      'INSERT INTO knowledge.ingestion_steps(run_id,step,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, 'proposal-ids', JSON.stringify(stable)],
    );
    await this.pool.query(
      'UPDATE knowledge.ingestion_runs SET candidates=$2,proposals=$3 WHERE id=$1',
      [id, JSON.stringify(merged), JSON.stringify(stable)],
    );
  }
}
