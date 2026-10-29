import { Type, type Static } from '@sinclair/typebox';
import { Id, DraftLinkSchema } from './knowledge.ts';
const closed = { additionalProperties: false };
export const ParsedSchema = Type.Object(
  {
    coreConcept: Type.String({ minLength: 1, maxLength: 200 }),
    summary: Type.String({
      minLength: 1,
      maxLength: 2000,
      description:
        '用简单语言直接解释概念是什么，给出定义，可补充一个简短例子。',
    }),
  },
  closed,
);
export type ParsedKnowledge = Static<typeof ParsedSchema>;
export const AnalysisSchema = Type.Object(
  {
    matches: Type.Array(
      Type.Object(
        {
          targetId: Id,
          level: Type.Union([
            Type.Literal('high'),
            Type.Literal('medium'),
            Type.Literal('low'),
          ]),
          reason: Type.String({ minLength: 1, maxLength: 1000 }),
          duplicate: Type.Boolean(),
        },
        closed,
      ),
      { maxItems: 10 },
    ),
    proposals: Type.Array(
      Type.Object(
        {
          ...DraftLinkSchema.properties,
          draftQuote: Type.String({ minLength: 1, maxLength: 500 }),
          targetQuote: Type.String({ minLength: 1, maxLength: 500 }),
          confidence: Type.Union([
            Type.Literal('supported'),
            Type.Literal('tentative'),
          ]),
        },
        closed,
      ),
      { maxItems: 5 },
    ),
  },
  closed,
);
export type ModelAnalysis = Static<typeof AnalysisSchema>;
export type MatchCandidate = {
  targetId: string;
  revision: number;
  title: string;
  excerpt: string;
  startLine: number;
  endLine: number;
  similarity: number;
  keywordScore: number;
  matchedBy: string[];
  neighbors?: {
    title: string;
    type: string;
    direction: 'incoming' | 'outgoing';
  }[];
  level?: 'high' | 'medium' | 'low';
  reason?: string;
  duplicate?: boolean;
};
export type RelationProposal = ModelAnalysis['proposals'][number] & {
  id: string;
};
export const ReviewSchema = Type.Object(
  {
    operationId: Id,
    expectedReviewVersion: Type.Integer({ minimum: 0 }),
    links: Type.Array(
      Type.Object(
        {
          ...DraftLinkSchema.properties,
          targetRevision: Type.Integer({ minimum: 1 }),
          proposalId: Type.Optional(Id),
        },
        closed,
      ),
      { maxItems: 30 },
    ),
    decisions: Type.Array(
      Type.Object({ proposalId: Id, accepted: Type.Boolean() }, closed),
      { maxItems: 5 },
    ),
    independent: Type.Boolean(),
  },
  closed,
);
export type IngestionReview = Static<typeof ReviewSchema>;
export const StartIngestionSchema = Type.Object(
  {
    operationId: Id,
    expectedRevision: Type.Integer({ minimum: 1 }),
    chatProfileId: Id,
    embeddingProfileId: Id,
  },
  closed,
);
export const ConfirmIngestionSchema = Type.Object(
  {
    expectedReviewVersion: Type.Integer({ minimum: 1 }),
    confirmed: Type.Literal(true),
  },
  closed,
);
export type IngestionRun = {
  id: string;
  draftId: string;
  draftRevision: number;
  workflowVersion: string;
  chatProfileId: string;
  embeddingProfileId: string;
  status:
    | 'queued'
    | 'processing'
    | 'review'
    | 'committing'
    | 'committed'
    | 'failed'
    | 'cancelled'
    | 'stale';
  stage: string;
  parsed: ParsedKnowledge | null;
  candidates: MatchCandidate[] | null;
  proposals: RelationProposal[] | null;
  decision: (IngestionReview & { id: string }) | null;
  reviewVersion: number;
  resultNodeId: string | null;
  error: string | null;
  progress: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  calls?: { count: number; durationMs: number; usage: unknown[] }[];
};
