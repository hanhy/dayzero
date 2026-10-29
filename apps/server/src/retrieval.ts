import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  KnowledgeContent,
  KnowledgeNode,
  MatchCandidate,
} from '@dayzero/contracts';
import { ApiError, rows } from './knowledge-service.ts';
import type { ModelConnection, ModelGateway } from './model-gateway.ts';
export function splitMarkdown(markdown: string) {
  const chunks: {
    text: string;
    startLine: number;
    endLine: number;
    hash: string;
  }[] = [];
  let text = '',
    startLine = 1,
    endLine = 1;
  const flush = () => {
    if (text.trim())
      chunks.push({
        text,
        startLine,
        endLine,
        hash: createHash('sha256').update(text).digest('hex'),
      });
    text = '';
  };
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      (/^#{1,6}\s/.test(line) && text.trim()) ||
      text.length + line.length > 1000
    )
      flush();
    for (let j = 0; j < Math.max(1, line.length); j += 1000) {
      const part = line.slice(j, j + 1000);
      if (!text) startLine = i + 1;
      text += (text ? '\n' : '') + part;
      endLine = i + 1;
      if (text.length >= 1000) flush();
    }
  }
  flush();
  return chunks.length
    ? chunks
    : [
        {
          text: '（无正文）',
          startLine: 1,
          endLine: 1,
          hash: createHash('sha256').update('').digest('hex'),
        },
      ];
}
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
export function keywords(text: string) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const bigrams = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(
    (match) =>
      Array.from({ length: match[0].length - 1 }, (_, index) =>
        match[0].slice(index, index + 2),
      ),
  );
  return [
    ...new Set([
      ...[...segmenter.segment(normalized)]
        .filter((s) => s.isWordLike && s.segment.length > 1)
        .map((s) => s.segment),
      ...bigrams,
    ]),
  ].slice(0, 100);
}
export function lexicalScore(query: string, text: string) {
  const words = keywords(query);
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const exact = query.normalize('NFKC').toLocaleLowerCase().trim();
  if (exact && normalized.includes(exact)) return 1;
  if (!words.length) return 0;
  return (
    words.filter((word) => normalized.includes(word)).length / words.length
  );
}
export async function retrieve(
  pool: Pool,
  gateway: ModelGateway,
  connection: ModelConnection,
  content: KnowledgeContent,
  runId: string,
  signal: AbortSignal,
  progress: (done: number, total: number) => Promise<void>,
) {
  const nodes = await rows<KnowledgeNode>(
    pool,
    `SELECT id,title,markdown,aliases,tags,sources,revision FROM knowledge.nodes WHERE deleted_at IS NULL ORDER BY id`,
  );
  if (!nodes.length) {
    await progress(0, 0);
    return [] as MatchCandidate[];
  }
  const query = `${content.title}\n${content.aliases.join(' ')}\n${content.markdown}`;
  const queryTexts = splitMarkdown(query).map((c) => c.text);
  const vectors: number[][] = [];
  for (let i = 0; i < queryTexts.length; i += 24)
    vectors.push(
      ...(await gateway.embed(connection, queryTexts.slice(i, i + 24), {
        runId,
        signal,
        purpose: 'query-embedding',
      })),
    );
  const dimensions = vectors[0]!.length;
  if (vectors.some((v) => v.length !== dimensions))
    throw new ApiError(502, '跨批次向量维度改变，请检查向量模型');
  const mean = Array.from(
    { length: dimensions },
    (_, i) => vectors.reduce((sum, v) => sum + v[i]!, 0) / vectors.length,
  );
  if (!mean.some((v) => v !== 0)) throw new ApiError(502, '查询向量不可用');
  let done = 0;
  for (const node of nodes) {
    signal.throwIfAborted();
    // Store raw body chunks separately so quoted line numbers refer to Markdown.
    const bodyChunks = splitMarkdown(node.markdown);
    const existing = await pool.query(
      'SELECT ordinal,content_hash,dimensions FROM knowledge.node_chunks WHERE node_id=$1 AND node_revision=$2 AND profile_version=$3',
      [node.id, node.revision, connection.version],
    );
    if (
      existing.rows.length !== bodyChunks.length ||
      existing.rows.some(
        (r: any) =>
          r.dimensions !== dimensions ||
          bodyChunks[r.ordinal]?.hash !== r.content_hash,
      )
    ) {
      for (let i = 0; i < bodyChunks.length; i += 24) {
        const batch = bodyChunks.slice(i, i + 24);
        const embedded = await gateway.embed(
          connection,
          batch.map(
            (c) => `${node.title}\n${node.aliases.join(' ')}\n${c.text}`,
          ),
          { runId, signal, purpose: 'index-embedding' },
        );
        if (embedded.some((v) => v.length !== dimensions))
          throw new ApiError(502, '索引与查询的向量维度不一致');
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          await pool.query(
            `INSERT INTO knowledge.node_chunks(node_id,node_revision,profile_version,ordinal,content_hash,text,start_line,end_line,dimensions,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector) ON CONFLICT(node_id,node_revision,profile_version,ordinal) DO UPDATE SET embedding=EXCLUDED.embedding,dimensions=EXCLUDED.dimensions,content_hash=EXCLUDED.content_hash,text=EXCLUDED.text,start_line=EXCLUDED.start_line,end_line=EXCLUDED.end_line`,
            [
              node.id,
              node.revision,
              connection.version,
              i + j,
              chunk.hash,
              chunk.text,
              chunk.startLine,
              chunk.endLine,
              dimensions,
              JSON.stringify(embedded[j]),
            ],
          );
        }
      }
    }
    await progress(++done, nodes.length);
  }
  const vectorRows = await rows<{
    nodeId: string;
    similarity: number;
    excerpt: string;
    startLine: number;
    endLine: number;
  }>(
    pool,
    `SELECT DISTINCT ON (c.node_id) c.node_id AS "nodeId", 1-(c.embedding <=> $1::vector) AS similarity,c.text AS excerpt,c.start_line AS "startLine",c.end_line AS "endLine" FROM knowledge.node_chunks c JOIN knowledge.nodes n ON n.id=c.node_id AND n.revision=c.node_revision AND n.deleted_at IS NULL WHERE c.profile_version=$2 AND c.dimensions=$3 ORDER BY c.node_id,c.embedding <=> $1::vector`,
    [JSON.stringify(mean), connection.version, dimensions],
  );
  const semantic = new Map(vectorRows.map((row) => [row.nodeId, row]));
  const candidates = nodes
    .map((node) => {
      const vector = semantic.get(node.id);
      const score = lexicalScore(
        query,
        `${node.title}\n${node.aliases.join(' ')}\n${node.tags.join(' ')}\n${node.markdown}`,
      );
      const parts = splitMarkdown(node.markdown);
      const keywordExcerpt = [...parts].sort(
        (a, b) => lexicalScore(query, b.text) - lexicalScore(query, a.text),
      )[0]!;
      const best =
        vector && vector.similarity >= 0.35
          ? vector
          : {
              excerpt: keywordExcerpt.text,
              startLine: keywordExcerpt.startLine,
              endLine: keywordExcerpt.endLine,
            };
      return {
        targetId: node.id,
        revision: node.revision,
        title: node.title,
        excerpt: best.excerpt,
        startLine: best.startLine,
        endLine: best.endLine,
        similarity: vector?.similarity ?? 0,
        keywordScore: score,
        matchedBy: [
          ...(score > 0 ? ['keyword'] : []),
          ...(vector && vector.similarity >= 0.35 ? ['vector'] : []),
        ],
      };
    })
    .filter((c) => c.matchedBy.length);
  const byVector = [...candidates]
    .filter((c) => c.similarity >= 0.35)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 40);
  const byKeyword = [...candidates]
    .filter((c) => c.keywordScore > 0)
    .sort((a, b) => b.keywordScore - a.keywordScore)
    .slice(0, 40);
  const rank = (c: MatchCandidate) => {
    const v = byVector.indexOf(c),
      k = byKeyword.indexOf(c);
    return (v >= 0 ? 1 / (20 + v) : 0) + (k >= 0 ? 1 / (20 + k) : 0);
  };
  const selected: MatchCandidate[] = candidates
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 10);
  for (const candidate of selected)
    candidate.neighbors = await rows(
      pool,
      `SELECT CASE WHEN r.source_id=$1 THEN target.title ELSE source.title END AS title,r.type,CASE WHEN r.source_id=$1 THEN 'outgoing' ELSE 'incoming' END AS direction FROM knowledge.relations r JOIN knowledge.nodes source ON source.id=r.source_id AND source.deleted_at IS NULL JOIN knowledge.nodes target ON target.id=r.target_id AND target.deleted_at IS NULL WHERE r.deleted_at IS NULL AND (r.source_id=$1 OR r.target_id=$1) ORDER BY r.updated_at DESC LIMIT 5`,
      [candidate.targetId],
    );
  return selected;
}
