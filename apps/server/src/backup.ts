import type { KnowledgeBackup, KnowledgeContent } from '@dayzero/contracts';
import { ApiError, KnowledgeService } from './knowledge-service.ts';

export function markdownFile(node: KnowledgeContent & { id: string }) {
  const metadata = ['id', 'title', 'aliases', 'tags', 'sources']
    .map((key) => `${key}: ${JSON.stringify(node[key as keyof typeof node])}`)
    .join('\n');
  return `---\n${metadata}\n---\n\n${node.markdown}`;
}

export function parseMarkdown(filename: string, text: string) {
  const fields = new Map<string, unknown>();
  let markdown = text.replace(/^\uFEFF/, '');
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (header && /^(title|aliases|tags|sources|id):/m.test(header[1]!)) {
    for (const line of header[1]!.split(/\r?\n/)) {
      const pair = line.match(/^(title|aliases|tags|sources|id):\s*(.*)$/);
      if (!pair) continue;
      try {
        fields.set(pair[1]!, JSON.parse(pair[2]!));
      } catch {
        if (pair[1] === 'title')
          fields.set('title', pair[2]!.replace(/^['"]|['"]$/g, ''));
        else throw new ApiError(400, 'front matter 列表请使用 JSON 数组格式');
      }
    }
    markdown = markdown.slice(header[0].length).replace(/^\r?\n/, '');
  }
  const array = (name: string, maxLength: number) => {
    const value = fields.get(name) ?? [];
    if (
      !Array.isArray(value) ||
      value.length > 30 ||
      value.some((item) => typeof item !== 'string' || item.length > maxLength)
    )
      throw new ApiError(400, `Markdown 元数据 ${name} 格式无效`);
    return value as string[];
  };
  if (fields.has('title') && typeof fields.get('title') !== 'string')
    throw new ApiError(400, 'Markdown 标题必须是文本');
  const title = String(
    fields.get('title') ??
      markdown.match(/^#\s+(.+)$/m)?.[1] ??
      filename.replace(/\.md$/i, '') ??
      '导入的知识点',
  ).trim();
  if (title.length > 200 || markdown.length > 1_000_000)
    throw new ApiError(400, '导入内容超过长度限制');
  return {
    title,
    markdown,
    aliases: array('aliases', 200),
    tags: array('tags', 100),
    sources: array('sources', 2000),
    links: [],
  };
}

function validateReferences(backup: KnowledgeBackup) {
  const unique = <T extends { id: string }>(items: T[], name: string) => {
    const map = new Map(items.map((item) => [item.id, item]));
    if (map.size !== items.length)
      throw new ApiError(400, `备份中的${name} ID 重复`);
    return map;
  };
  const nodes = unique(backup.nodes, '节点');
  unique(backup.drafts, '草稿');
  unique(backup.events, '事件');
  unique(backup.relations, '关系');
  const confirmations = unique(backup.confirmations, '确认');
  for (const node of backup.nodes) {
    const confirmation = confirmations.get(node.confirmationId);
    if (
      !node.title.trim() ||
      !confirmation ||
      confirmation.entityKind !== 'node' ||
      confirmation.entityId !== node.id
    )
      throw new ApiError(400, '备份中的节点确认来源无效');
    if (
      !backup.revisions.some(
        (item) => item.nodeId === node.id && item.revision === node.revision,
      )
    )
      throw new ApiError(400, '备份缺少当前节点版本');
  }
  for (const draft of backup.drafts)
    if (draft.committedNodeId && !nodes.has(draft.committedNodeId))
      throw new ApiError(400, '草稿指向不存在的正式节点');
  const active = new Set<string>();
  for (const edge of backup.relations) {
    const source = nodes.get(edge.sourceId),
      target = nodes.get(edge.targetId),
      confirmation = confirmations.get(edge.confirmationId);
    if (!source || !target || edge.sourceId === edge.targetId || !confirmation)
      throw new ApiError(400, '备份关系存在无效端点或确认来源');
    if (
      confirmation.entityKind === 'relation'
        ? confirmation.entityId !== edge.id
        : ![edge.sourceId, edge.targetId].includes(confirmation.entityId)
    )
      throw new ApiError(400, '关系与确认记录不匹配');
    if (edge.deletedByNode && !nodes.has(edge.deletedByNode))
      throw new ApiError(400, '关系删除来源不存在');
    if (
      ['related', 'contrast'].includes(edge.type) &&
      edge.sourceId > edge.targetId
    )
      throw new ApiError(400, '备份的对称关系端点顺序不规范');
    if (!edge.deletedAt) {
      if (source.deletedAt || target.deletedAt)
        throw new ApiError(400, '活动关系不能引用已删除节点');
      const key = `${edge.sourceId}:${edge.targetId}:${edge.type}`;
      if (active.has(key)) throw new ApiError(400, '备份存在重复活动关系');
      active.add(key);
    }
  }
  const versions = new Set<string>();
  for (const revision of backup.revisions) {
    const key = `${revision.nodeId}:${revision.revision}`;
    if (
      !nodes.has(revision.nodeId) ||
      revision.snapshot.id !== revision.nodeId ||
      revision.snapshot.revision !== revision.revision ||
      versions.has(key)
    )
      throw new ApiError(400, '备份版本记录无效');
    versions.add(key);
  }
}

export class Backups {
  constructor(private service: KnowledgeService) {}
  async preview(backup: KnowledgeBackup) {
    validateReferences(backup);
    const result = await this.service.pool.query(
      'SELECT (SELECT count(*) FROM knowledge.nodes) + (SELECT count(*) FROM knowledge.drafts) AS count',
    );
    return {
      nodes: backup.nodes.length,
      drafts: backup.drafts.filter((draft) => !draft.committedNodeId).length,
      relations: backup.relations.length,
      canRestore: Number(result.rows[0].count) === 0,
    };
  }
  restore(backup: KnowledgeBackup, operationId: string) {
    return this.service.mutate(
      'backup.restore',
      operationId,
      backup,
      async (client) => {
        validateReferences(backup);
        const existing = await client.query(
          'SELECT (SELECT count(*) FROM knowledge.nodes) + (SELECT count(*) FROM knowledge.drafts) + (SELECT count(*) FROM knowledge.confirmations) + (SELECT count(*) FROM knowledge.events) AS count',
        );
        if (Number(existing.rows[0].count))
          throw new ApiError(409, '请在空知识库恢复备份，现有数据不会被覆盖');
        for (const c of backup.confirmations)
          await client.query(
            'INSERT INTO knowledge.confirmations(id,operation_id,entity_kind,entity_id,decision,created_at) VALUES($1,$2,$3,$4,$5,$6)',
            [
              c.id,
              c.operationId,
              c.entityKind,
              c.entityId,
              JSON.stringify(c.decision),
              c.createdAt,
            ],
          );
        for (const n of backup.nodes)
          await client.query(
            'INSERT INTO knowledge.nodes(id,title,markdown,aliases,tags,sources,revision,position,confirmation_id,deleted_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              n.id,
              n.title,
              n.markdown,
              n.aliases,
              n.tags,
              n.sources,
              n.revision,
              n.position,
              n.confirmationId,
              n.deletedAt,
              n.createdAt,
              n.updatedAt,
            ],
          );
        for (const d of backup.drafts)
          await client.query(
            'INSERT INTO knowledge.drafts(id,title,markdown,aliases,tags,sources,links,revision,committed_node_id,deleted_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              d.id,
              d.title,
              d.markdown,
              d.aliases,
              d.tags,
              d.sources,
              JSON.stringify(d.links),
              d.revision,
              d.committedNodeId,
              d.deletedAt,
              d.createdAt,
              d.updatedAt,
            ],
          );
        for (const r of backup.relations)
          await client.query(
            'INSERT INTO knowledge.relations(id,source_id,target_id,type,description,confirmation_id,revision,deleted_at,deleted_by_node,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [
              r.id,
              r.sourceId,
              r.targetId,
              r.type,
              r.description,
              r.confirmationId,
              r.revision,
              r.deletedAt,
              r.deletedByNode,
              r.createdAt,
              r.updatedAt,
            ],
          );
        for (const v of backup.revisions)
          await client.query(
            'INSERT INTO knowledge.node_revisions(node_id,revision,snapshot,reason,created_at) VALUES($1,$2,$3,$4,$5)',
            [
              v.nodeId,
              v.revision,
              JSON.stringify(v.snapshot),
              v.reason,
              v.createdAt,
            ],
          );
        for (const e of backup.events)
          await client.query(
            'INSERT INTO knowledge.events(id,operation_id,entity_kind,entity_id,action,before_data,after_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              e.id,
              e.operationId,
              e.entityKind,
              e.entityId,
              e.action,
              JSON.stringify(e.before),
              JSON.stringify(e.after),
              e.createdAt,
            ],
          );
        const cycle = await client.query(`WITH RECURSIVE walk(start,id) AS (
        SELECT source_id,target_id FROM knowledge.relations WHERE type='prerequisite' AND deleted_at IS NULL
        UNION SELECT w.start,r.target_id FROM walk w JOIN knowledge.relations r ON r.source_id=w.id WHERE r.type='prerequisite' AND r.deleted_at IS NULL
      ) SELECT 1 FROM walk WHERE start=id LIMIT 1`);
        if (cycle.rowCount) throw new ApiError(400, '备份含循环前置关系');
        const result = {
          nodes: backup.nodes.length,
          drafts: backup.drafts.length,
          relations: backup.relations.length,
        };
        await client.query(
          'INSERT INTO knowledge.outbox(id,operation_id,kind,payload) VALUES($1,$2,$3,$4)',
          [randomId(), operationId, 'library.restored', JSON.stringify(result)],
        );
        return result;
      },
    );
  }
}

import { randomUUID as randomId } from 'node:crypto';
