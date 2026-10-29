import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  DraftContent,
  KnowledgeContent,
  KnowledgeDraft,
  KnowledgeNode,
  KnowledgeRelation,
  KnowledgeBackup,
  RelationInput,
  IngestionRun,
  Library,
  NodeHistory,
} from '@dayzero/contracts';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const nodeFields = `id,title,markdown,aliases,tags,sources,revision,position,confirmation_id AS "confirmationId",deleted_at AS "deletedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;
const draftFields = `id,title,markdown,aliases,tags,sources,links,revision,committed_node_id AS "committedNodeId",deleted_at AS "deletedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;
const relationFields = `id,source_id AS "sourceId",target_id AS "targetId",type,description,confirmation_id AS "confirmationId",revision,deleted_at AS "deletedAt",deleted_by_node AS "deletedByNode",created_at AS "createdAt",updated_at AS "updatedAt"`;
const eventFields = `id,operation_id AS "operationId",entity_kind AS "entityKind",entity_id AS "entityId",action,before_data AS "before",after_data AS "after",created_at AS "createdAt"`;
const confirmationFields = `id,operation_id AS "operationId",entity_kind AS "entityKind",entity_id AS "entityId",decision,created_at AS "createdAt"`;
const revisionFields = `node_id AS "nodeId",revision,snapshot,reason,created_at AS "createdAt"`;
type Client = Pick<PoolClient, 'query'>;
const serial = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));
async function rows<T>(
  client: Client,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return serial<T[]>((await client.query(sql, values)).rows);
}
async function one<T>(
  client: Client,
  sql: string,
  values: unknown[],
): Promise<T> {
  const result = (await rows<T>(client, sql, values))[0];
  if (!result) throw new ApiError(404, '记录不存在');
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
function content(input: KnowledgeContent): KnowledgeContent {
  const clean = (items: string[]) => [
    ...new Set(items.map((value) => value.trim()).filter(Boolean)),
  ];
  return {
    title: input.title.trim(),
    markdown: input.markdown,
    aliases: clean(input.aliases),
    tags: clean(input.tags),
    sources: clean(input.sources),
  };
}
function checkVersion(record: { revision: number }, expected: number) {
  if (record.revision !== expected)
    throw new ApiError(
      409,
      '内容已被其他操作更新，请保留当前编辑并重新载入最新版本',
    );
}
function active(record: { deletedAt: string | null }) {
  if (record.deletedAt) throw new ApiError(409, '记录已在回收站，请先恢复');
}

export class KnowledgeService {
  constructor(public pool: Pool) {}

  private async read<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async mutate<T>(
    kind: string,
    operationId: string,
    payload: unknown,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One local knowledge space: serialize graph mutations and restores consistently.
      await client.query('SELECT pg_advisory_xact_lock(725002)');
      await client.query("SET LOCAL statement_timeout = '8s'");
      const prior = (
        await rows<{ kind: string; payload_hash: string; result: T }>(
          client,
          'SELECT kind,payload_hash,result FROM knowledge.operations WHERE id=$1',
          [operationId],
        )
      )[0];
      if (prior) {
        if (prior.kind !== kind || prior.payload_hash !== hash)
          throw new ApiError(409, '操作 ID 已用于不同内容');
        await client.query('COMMIT');
        return prior.result;
      }
      const result = await fn(client);
      await client.query(
        'INSERT INTO knowledge.operations(id,kind,payload_hash,result) VALUES($1,$2,$3,$4)',
        [operationId, kind, hash, JSON.stringify(result)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async library(): Promise<Library> {
    return this.read(async (client) => ({
      nodes: await rows<KnowledgeNode>(
        client,
        `SELECT ${nodeFields} FROM knowledge.nodes ORDER BY created_at,id`,
      ),
      drafts: await rows<KnowledgeDraft>(
        client,
        `SELECT ${draftFields} FROM knowledge.drafts ORDER BY updated_at DESC,id`,
      ),
      relations: await rows<KnowledgeRelation>(
        client,
        `SELECT ${relationFields} FROM knowledge.relations ORDER BY created_at,id`,
      ),
    }));
  }
  async search(query: string) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    return rows<KnowledgeNode>(
      this.pool,
      `SELECT ${nodeFields} FROM knowledge.nodes WHERE deleted_at IS NULL AND
      (search_text ILIKE $1 OR array_to_string(aliases,' ') ILIKE $1 OR array_to_string(tags,' ') ILIKE $1 OR array_to_string(sources,' ') ILIKE $1)
      ORDER BY updated_at DESC LIMIT 100`,
      [`%${escaped}%`],
    );
  }
  node(client: Client, id: string) {
    return one<KnowledgeNode>(
      client,
      `SELECT ${nodeFields} FROM knowledge.nodes WHERE id=$1`,
      [id],
    );
  }
  draft(client: Client, id: string) {
    return one<KnowledgeDraft>(
      client,
      `SELECT ${draftFields} FROM knowledge.drafts WHERE id=$1`,
      [id],
    );
  }
  relation(client: Client, id: string) {
    return one<KnowledgeRelation>(
      client,
      `SELECT ${relationFields} FROM knowledge.relations WHERE id=$1`,
      [id],
    );
  }

  private async event(
    client: Client,
    operationId: string,
    entityKind: string,
    entityId: string,
    action: string,
    before: unknown,
    after: unknown,
    notify = false,
  ) {
    const id = randomUUID();
    await client.query(
      'INSERT INTO knowledge.events(id,operation_id,entity_kind,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        operationId,
        entityKind,
        entityId,
        action,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
    if (notify)
      await client.query(
        'INSERT INTO knowledge.outbox(id,operation_id,kind,payload) VALUES($1,$2,$3,$4)',
        [
          id,
          operationId,
          `${entityKind}.${action}`,
          JSON.stringify({
            entityId,
            revision: (after as { revision?: number } | null)?.revision,
          }),
        ],
      );
  }
  private async snapshot(client: Client, node: KnowledgeNode, reason: string) {
    await client.query(
      'INSERT INTO knowledge.node_revisions(node_id,revision,snapshot,reason) VALUES($1,$2,$3,$4)',
      [node.id, node.revision, JSON.stringify(node), reason],
    );
  }
  private async confirmation(
    client: Client,
    operationId: string,
    kind: 'node' | 'relation',
    id: string,
    decision: unknown,
  ) {
    const confirmationId = randomUUID();
    await client.query(
      'INSERT INTO knowledge.confirmations(id,operation_id,entity_kind,entity_id,decision) VALUES($1,$2,$3,$4,$5)',
      [confirmationId, operationId, kind, id, JSON.stringify(decision)],
    );
    return confirmationId;
  }
  async createDraft(operationId: string, initial?: DraftContent) {
    return this.mutate(
      'draft.create',
      operationId,
      initial ?? {},
      async (client) => {
        const value = initial ?? {
          title: '',
          markdown: '',
          aliases: [],
          tags: [],
          sources: [],
          links: [],
        };
        const clean = content(value);
        const draft = await one<KnowledgeDraft>(
          client,
          `INSERT INTO knowledge.drafts(id,title,markdown,aliases,tags,sources,links) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${draftFields}`,
          [
            randomUUID(),
            clean.title,
            clean.markdown,
            clean.aliases,
            clean.tags,
            clean.sources,
            JSON.stringify(value.links),
          ],
        );
        await this.event(
          client,
          operationId,
          'draft',
          draft.id,
          'created',
          null,
          { id: draft.id, revision: draft.revision, title: draft.title },
        );
        return draft;
      },
    );
  }
  async saveDraft(
    id: string,
    input: DraftContent & { operationId: string; expectedRevision: number },
  ) {
    return this.mutate(
      'draft.save',
      input.operationId,
      { id, ...input },
      async (client) => {
        const before = await this.draft(client, id);
        active(before);
        checkVersion(before, input.expectedRevision);
        if (before.committedNodeId)
          throw new ApiError(409, '草稿已入图，请编辑正式知识点');
        const clean = content(input);
        const after = await one<KnowledgeDraft>(
          client,
          `UPDATE knowledge.drafts SET title=$2,markdown=$3,aliases=$4,tags=$5,sources=$6,links=$7,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${draftFields}`,
          [
            id,
            clean.title,
            clean.markdown,
            clean.aliases,
            clean.tags,
            clean.sources,
            JSON.stringify(input.links),
          ],
        );
        await this.event(
          client,
          input.operationId,
          'draft',
          id,
          'saved',
          { revision: before.revision },
          { revision: after.revision, title: after.title },
        );
        return after;
      },
    );
  }
  async commitDraft(
    id: string,
    input: { operationId: string; expectedRevision: number; confirmed: true },
    workflow?: { runId: string; decisionId: string },
  ) {
    return this.mutate(
      'draft.commit',
      input.operationId,
      { id, ...input, ...(workflow ? { workflow } : {}) },
      async (client) => {
        const draft = await this.draft(client, id);
        let workflowRun: IngestionRun | undefined;
        if (workflow) {
          const result = await client.query(
            'SELECT status,decision,draft_id,draft_revision,parsed,candidates,proposals,workflow_version AS "workflowVersion" FROM knowledge.ingestion_runs WHERE id=$1',
            [workflow.runId],
          );
          const run = result.rows[0];
          if (
            !run ||
            run.status !== 'committing' ||
            run.draft_id !== id ||
            run.draft_revision !== draft.revision ||
            run.decision?.id !== workflow.decisionId
          )
            throw new ApiError(409, '工作流确认已经失效或被取消');
          for (const link of run.decision.links) {
            const target = await this.node(client, link.targetId);
            if (target.deletedAt || target.revision !== link.targetRevision)
              throw new ApiError(409, '关联目标已修改或删除，请重新分析');
          }
          workflowRun = run;
          draft.links = run.decision.links.map(
            ({
              targetId,
              type,
              direction,
              description,
            }: DraftContent['links'][number]) => ({
              targetId,
              type,
              direction,
              description,
            }),
          );
        }
        active(draft);
        checkVersion(draft, input.expectedRevision);
        if (draft.committedNodeId)
          throw new ApiError(409, '此草稿已经加入图谱');
        const clean = content(draft);
        if (!clean.title) throw new ApiError(400, '加入图谱前请填写知识点标题');
        const nodeId = randomUUID();
        const confirmationId = await this.confirmation(
          client,
          input.operationId,
          'node',
          nodeId,
          {
            draftId: id,
            draftRevision: draft.revision,
            confirmed: input.confirmed,
            links: draft.links,
            ...(workflow
              ? {
                  runId: workflow.runId,
                  decision: workflowRun?.decision,
                  workflowVersion: workflowRun?.workflowVersion,
                  analysis: {
                    parsed: workflowRun?.parsed,
                    candidates: workflowRun?.candidates,
                    proposals: workflowRun?.proposals,
                  },
                }
              : {}),
          },
        );
        const count = Number(
          (await client.query('SELECT count(*) FROM knowledge.nodes')).rows[0]
            .count,
        );
        const hash = createHash('sha256').update(nodeId).digest();
        const position =
          count === 0
            ? [0, 0, 0]
            : [
                (hash[0]! / 255) * 160 - 80,
                (hash[1]! / 255) * 100 - 50,
                (hash[2]! / 255) * 160 - 80,
              ];
        const node = await one<KnowledgeNode>(
          client,
          `INSERT INTO knowledge.nodes(id,title,markdown,aliases,tags,sources,position,confirmation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${nodeFields}`,
          [
            nodeId,
            clean.title,
            clean.markdown,
            clean.aliases,
            clean.tags,
            clean.sources,
            position,
            confirmationId,
          ],
        );
        await this.snapshot(client, node, 'created');
        await this.event(
          client,
          input.operationId,
          'node',
          node.id,
          'created',
          null,
          node,
          true,
        );
        const relations: KnowledgeRelation[] = [];
        for (const link of draft.links) {
          const sourceId =
            link.direction === 'outgoing' ? node.id : link.targetId;
          const targetId =
            link.direction === 'outgoing' ? link.targetId : node.id;
          relations.push(
            await this.insertRelation(
              client,
              input.operationId,
              {
                sourceId,
                targetId,
                type: link.type,
                description: link.description,
              },
              confirmationId,
            ),
          );
        }
        const committed = await one<KnowledgeDraft>(
          client,
          `UPDATE knowledge.drafts SET committed_node_id=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${draftFields}`,
          [id, node.id],
        );
        await this.event(
          client,
          input.operationId,
          'draft',
          id,
          'committed',
          { revision: draft.revision },
          { nodeId: node.id, revision: committed.revision },
        );
        if (workflow)
          await client.query(
            "UPDATE knowledge.ingestion_runs SET status='committed',stage='committed',result_node_id=$2,error=NULL,updated_at=now() WHERE id=$1",
            [workflow.runId, node.id],
          );
        return { node, draft: committed, relations };
      },
    );
  }
  private async writeNode(
    client: Client,
    before: KnowledgeNode,
    input: KnowledgeContent,
    operationId: string,
    reason = 'saved',
  ) {
    const clean = content(input);
    if (!clean.title) throw new ApiError(400, '知识点标题不能为空');
    const node = await one<KnowledgeNode>(
      client,
      `UPDATE knowledge.nodes SET title=$2,markdown=$3,aliases=$4,tags=$5,sources=$6,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${nodeFields}`,
      [
        before.id,
        clean.title,
        clean.markdown,
        clean.aliases,
        clean.tags,
        clean.sources,
      ],
    );
    await this.snapshot(client, node, reason);
    await this.event(
      client,
      operationId,
      'node',
      node.id,
      reason,
      before,
      node,
      true,
    );
    return node;
  }
  async saveNode(
    id: string,
    input: KnowledgeContent & { operationId: string; expectedRevision: number },
  ) {
    return this.mutate(
      'node.save',
      input.operationId,
      { id, ...input },
      async (client) => {
        const before = await this.node(client, id);
        active(before);
        checkVersion(before, input.expectedRevision);
        return this.writeNode(client, before, input, input.operationId);
      },
    );
  }
  async history(id: string): Promise<NodeHistory> {
    await this.node(this.pool, id);
    return this.read(async (client) => ({
      revisions: await rows(
        client,
        `SELECT ${revisionFields} FROM knowledge.node_revisions WHERE node_id=$1 ORDER BY revision DESC`,
        [id],
      ),
      events: await rows(
        client,
        `SELECT ${eventFields} FROM knowledge.events WHERE entity_kind='node' AND entity_id=$1 ORDER BY created_at DESC,id`,
        [id],
      ),
    }));
  }
  async restoreVersion(
    id: string,
    input: { operationId: string; expectedRevision: number; version: number },
  ) {
    return this.mutate(
      'node.version-restore',
      input.operationId,
      { id, ...input },
      async (client) => {
        const current = await this.node(client, id);
        active(current);
        checkVersion(current, input.expectedRevision);
        const revision = await one<{ snapshot: KnowledgeNode }>(
          client,
          'SELECT snapshot FROM knowledge.node_revisions WHERE node_id=$1 AND revision=$2',
          [id, input.version],
        );
        return this.writeNode(
          client,
          current,
          revision.snapshot,
          input.operationId,
          'version-restored',
        );
      },
    );
  }
  private async normalizeRelation(
    client: Client,
    input: RelationInput,
    excludeId: string | null = null,
  ) {
    const value = {
      ...input,
      sourceId: input.sourceId.toLowerCase(),
      targetId: input.targetId.toLowerCase(),
      description: input.description.trim(),
    };
    if (value.sourceId === value.targetId)
      throw new ApiError(400, '不能将知识点连接到自身');
    active(await this.node(client, value.sourceId));
    active(await this.node(client, value.targetId));
    if (
      ['related', 'contrast'].includes(value.type) &&
      value.sourceId > value.targetId
    )
      [value.sourceId, value.targetId] = [value.targetId, value.sourceId];
    const duplicate = await client.query(
      'SELECT id FROM knowledge.relations WHERE source_id=$1 AND target_id=$2 AND type=$3 AND deleted_at IS NULL AND ($4::uuid IS NULL OR id<>$4)',
      [value.sourceId, value.targetId, value.type, excludeId],
    );
    if (duplicate.rowCount)
      throw new ApiError(409, '这两个知识点之间已存在同类型关系');
    if (value.type === 'prerequisite') {
      const cycle = await client.query(
        `WITH RECURSIVE walk(id) AS (
        SELECT target_id FROM knowledge.relations WHERE source_id=$1 AND type='prerequisite' AND deleted_at IS NULL AND ($3::uuid IS NULL OR id<>$3)
        UNION SELECT r.target_id FROM knowledge.relations r JOIN walk w ON r.source_id=w.id WHERE r.type='prerequisite' AND r.deleted_at IS NULL AND ($3::uuid IS NULL OR r.id<>$3)
      ) SELECT 1 FROM walk WHERE id=$2 LIMIT 1`,
        [value.targetId, value.sourceId, excludeId],
      );
      if (cycle.rowCount)
        throw new ApiError(409, '这条前置关系会形成循环，请核查方向或改为相关');
    }
    return value;
  }
  private async insertRelation(
    client: Client,
    operationId: string,
    input: RelationInput,
    confirmationId: string,
  ) {
    const value = await this.normalizeRelation(client, input);
    const relation = await one<KnowledgeRelation>(
      client,
      `INSERT INTO knowledge.relations(id,source_id,target_id,type,description,confirmation_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${relationFields}`,
      [
        randomUUID(),
        value.sourceId,
        value.targetId,
        value.type,
        value.description,
        confirmationId,
      ],
    );
    await this.event(
      client,
      operationId,
      'relation',
      relation.id,
      'created',
      null,
      relation,
      true,
    );
    return relation;
  }
  async createRelation(
    input: RelationInput & { operationId: string; confirmed: true },
  ) {
    return this.mutate(
      'relation.create',
      input.operationId,
      input,
      async (client) => {
        const id = randomUUID();
        const confirmationId = await this.confirmation(
          client,
          input.operationId,
          'relation',
          id,
          input,
        );
        const value = await this.normalizeRelation(client, input);
        const relation = await one<KnowledgeRelation>(
          client,
          `INSERT INTO knowledge.relations(id,source_id,target_id,type,description,confirmation_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${relationFields}`,
          [
            id,
            value.sourceId,
            value.targetId,
            value.type,
            value.description,
            confirmationId,
          ],
        );
        await this.event(
          client,
          input.operationId,
          'relation',
          id,
          'created',
          null,
          relation,
          true,
        );
        return relation;
      },
    );
  }
  async saveRelation(
    id: string,
    input: RelationInput & {
      operationId: string;
      expectedRevision: number;
      confirmed: true;
    },
  ) {
    return this.mutate(
      'relation.save',
      input.operationId,
      { id, ...input },
      async (client) => {
        const before = await this.relation(client, id);
        active(before);
        checkVersion(before, input.expectedRevision);
        const value = await this.normalizeRelation(client, input, id);
        const confirmationId = await this.confirmation(
          client,
          input.operationId,
          'relation',
          id,
          input,
        );
        const after = await one<KnowledgeRelation>(
          client,
          `UPDATE knowledge.relations SET source_id=$2,target_id=$3,type=$4,description=$5,confirmation_id=$6,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${relationFields}`,
          [
            id,
            value.sourceId,
            value.targetId,
            value.type,
            value.description,
            confirmationId,
          ],
        );
        await this.event(
          client,
          input.operationId,
          'relation',
          id,
          'saved',
          before,
          after,
          true,
        );
        return after;
      },
    );
  }
  relationHistory(id: string) {
    return rows(
      this.pool,
      `SELECT ${eventFields} FROM knowledge.events WHERE entity_kind='relation' AND entity_id=$1 ORDER BY created_at DESC,id`,
      [id],
    );
  }
  async trash(
    kind: 'node' | 'draft' | 'relation',
    id: string,
    input: { operationId: string; expectedRevision: number },
    restore = false,
  ) {
    return this.mutate(
      `${kind}.${restore ? 'restore' : 'delete'}`,
      input.operationId,
      { id, ...input },
      async (client) => {
        const before =
          kind === 'node'
            ? await this.node(client, id)
            : kind === 'draft'
              ? await this.draft(client, id)
              : await this.relation(client, id);
        checkVersion(before, input.expectedRevision);
        if (Boolean(before.deletedAt) !== restore)
          throw new ApiError(409, restore ? '记录并未删除' : '记录已删除');
        if ('committedNodeId' in before && before.committedNodeId)
          throw new ApiError(409, '草稿已入图，请操作正式知识点');
        if (kind === 'relation' && restore)
          await this.normalizeRelation(client, before as KnowledgeRelation, id);
        const fields =
          kind === 'node'
            ? nodeFields
            : kind === 'draft'
              ? draftFields
              : relationFields;
        const table = { node: 'nodes', draft: 'drafts', relation: 'relations' }[
          kind
        ];
        const after = await one<
          KnowledgeNode | KnowledgeDraft | KnowledgeRelation
        >(
          client,
          `UPDATE knowledge.${table} SET deleted_at=${restore ? 'NULL' : 'now()'},revision=revision+1,updated_at=now() ${kind === 'relation' ? ',deleted_by_node=NULL' : ''} WHERE id=$1 RETURNING ${fields}`,
          [id],
        );
        if (kind === 'node')
          await this.snapshot(
            client,
            after as KnowledgeNode,
            restore ? 'restored' : 'deleted',
          );
        await this.event(
          client,
          input.operationId,
          kind,
          id,
          restore ? 'restored' : 'deleted',
          before,
          after,
          kind !== 'draft',
        );
        let restoredRelations = 0,
          skippedRelations = 0;
        if (kind === 'node') {
          const linked = await rows<KnowledgeRelation>(
            client,
            `SELECT ${relationFields} FROM knowledge.relations WHERE (source_id=$1 OR target_id=$1) AND ${restore ? 'deleted_at IS NOT NULL AND deleted_by_node IS NOT NULL' : 'deleted_at IS NULL'}`,
            [id],
          );
          for (const relation of linked) {
            if (restore) {
              try {
                await this.normalizeRelation(client, relation, relation.id);
              } catch (error) {
                if (error instanceof ApiError) {
                  skippedRelations++;
                  continue;
                }
                throw error;
              }
            }
            const updated = await one<KnowledgeRelation>(
              client,
              `UPDATE knowledge.relations SET deleted_at=${restore ? 'NULL' : 'now()'},deleted_by_node=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ${relationFields}`,
              [relation.id, restore ? null : id],
            );
            await this.event(
              client,
              input.operationId,
              'relation',
              relation.id,
              restore ? 'node-restored' : 'node-deleted',
              relation,
              updated,
              true,
            );
            if (restore) restoredRelations++;
          }
        }
        return { record: after, restoredRelations, skippedRelations };
      },
    );
  }

  async backup(): Promise<KnowledgeBackup> {
    return this.read(async (client) => ({
      format: 'dayzero-knowledge',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      nodes: await rows(
        client,
        `SELECT ${nodeFields} FROM knowledge.nodes ORDER BY created_at,id`,
      ),
      drafts: await rows(
        client,
        `SELECT ${draftFields} FROM knowledge.drafts ORDER BY created_at,id`,
      ),
      relations: await rows(
        client,
        `SELECT ${relationFields} FROM knowledge.relations ORDER BY created_at,id`,
      ),
      revisions: await rows(
        client,
        `SELECT ${revisionFields} FROM knowledge.node_revisions ORDER BY node_id,revision`,
      ),
      confirmations: await rows(
        client,
        `SELECT ${confirmationFields} FROM knowledge.confirmations ORDER BY created_at,id`,
      ),
      events: await rows(
        client,
        `SELECT ${eventFields} FROM knowledge.events ORDER BY created_at,id`,
      ),
    }));
  }
}

export { content, nodeFields, draftFields, relationFields, rows };
