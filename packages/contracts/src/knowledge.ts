import { Type, type Static } from '@sinclair/typebox';

const closed = { additionalProperties: false };
export const Id = Type.String({ format: 'uuid' });
export const Timestamp = Type.String({ format: 'date-time' });
const NullableDate = Type.Union([Timestamp, Type.Null()]);
const NullableId = Type.Union([Id, Type.Null()]);
export const RelationTypeSchema = Type.Union([
  Type.Literal('related'),
  Type.Literal('prerequisite'),
  Type.Literal('part_of'),
  Type.Literal('used_for'),
  Type.Literal('contrast'),
]);
export type RelationType = Static<typeof RelationTypeSchema>;
export const relationLabels: Record<RelationType, string> = {
  related: '相关',
  prerequisite: '前置于',
  part_of: '属于',
  used_for: '用于',
  contrast: '对比',
};
export const ContentSchema = Type.Object(
  {
    title: Type.String({ maxLength: 200 }),
    markdown: Type.String({ maxLength: 1_000_000 }),
    aliases: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 30 }),
    tags: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 30 }),
    sources: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 30 }),
  },
  closed,
);
export type KnowledgeContent = Static<typeof ContentSchema>;
export const DraftLinkSchema = Type.Object(
  {
    targetId: Id,
    type: RelationTypeSchema,
    direction: Type.Union([Type.Literal('outgoing'), Type.Literal('incoming')]),
    description: Type.String({ maxLength: 5000 }),
  },
  closed,
);
export type DraftLink = Static<typeof DraftLinkSchema>;
export const DraftContentSchema = Type.Object(
  {
    ...ContentSchema.properties,
    links: Type.Array(DraftLinkSchema, { maxItems: 30 }),
  },
  closed,
);
export type DraftContent = Static<typeof DraftContentSchema>;
const RecordFields = {
  id: Id,
  revision: Type.Integer({ minimum: 1 }),
  deletedAt: NullableDate,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};
export const NodeSchema = Type.Object(
  {
    ...ContentSchema.properties,
    ...RecordFields,
    position: Type.Tuple([
      Type.Number({ minimum: -1e6, maximum: 1e6 }),
      Type.Number({ minimum: -1e6, maximum: 1e6 }),
      Type.Number({ minimum: -1e6, maximum: 1e6 }),
    ]),
    confirmationId: Id,
  },
  closed,
);
export type KnowledgeNode = Static<typeof NodeSchema>;
export const DraftSchema = Type.Object(
  {
    ...DraftContentSchema.properties,
    ...RecordFields,
    committedNodeId: NullableId,
  },
  closed,
);
export type KnowledgeDraft = Static<typeof DraftSchema>;
export const RelationSchema = Type.Object(
  {
    ...RecordFields,
    sourceId: Id,
    targetId: Id,
    type: RelationTypeSchema,
    description: Type.String({ maxLength: 5000 }),
    confirmationId: Id,
    deletedByNode: NullableId,
  },
  closed,
);
export type KnowledgeRelation = Static<typeof RelationSchema>;
export const ConfirmationSchema = Type.Object(
  {
    id: Id,
    operationId: Id,
    entityKind: Type.Union([Type.Literal('node'), Type.Literal('relation')]),
    entityId: Id,
    decision: Type.Unknown(),
    createdAt: Timestamp,
  },
  closed,
);
export const RevisionSchema = Type.Object(
  {
    nodeId: Id,
    revision: Type.Integer({ minimum: 1 }),
    snapshot: NodeSchema,
    reason: Type.String({ maxLength: 100 }),
    createdAt: Timestamp,
  },
  closed,
);
export const EventSchema = Type.Object(
  {
    id: Id,
    operationId: Id,
    entityKind: Type.Union([
      Type.Literal('node'),
      Type.Literal('draft'),
      Type.Literal('relation'),
    ]),
    entityId: Id,
    action: Type.String({ maxLength: 100 }),
    before: Type.Unknown(),
    after: Type.Unknown(),
    createdAt: Timestamp,
  },
  closed,
);
export type KnowledgeRevision = Static<typeof RevisionSchema>;
export type KnowledgeEvent = Static<typeof EventSchema>;
export type Library = {
  nodes: KnowledgeNode[];
  drafts: KnowledgeDraft[];
  relations: KnowledgeRelation[];
};
export type NodeHistory = {
  revisions: KnowledgeRevision[];
  events: KnowledgeEvent[];
};
export const OperationSchema = Type.Object({ operationId: Id }, closed);
export const VersionOperationSchema = Type.Object(
  { operationId: Id, expectedRevision: Type.Integer({ minimum: 1 }) },
  closed,
);
export const SaveDraftSchema = Type.Object(
  { ...VersionOperationSchema.properties, ...DraftContentSchema.properties },
  closed,
);
export const SaveNodeSchema = Type.Object(
  { ...VersionOperationSchema.properties, ...ContentSchema.properties },
  closed,
);
export const CommitSchema = Type.Object(
  { ...VersionOperationSchema.properties, confirmed: Type.Literal(true) },
  closed,
);
export const RelationInputSchema = Type.Object(
  {
    sourceId: Id,
    targetId: Id,
    type: RelationTypeSchema,
    description: Type.String({ maxLength: 5000 }),
  },
  closed,
);
export type RelationInput = Static<typeof RelationInputSchema>;
export const CreateRelationSchema = Type.Object(
  {
    ...OperationSchema.properties,
    ...RelationInputSchema.properties,
    confirmed: Type.Literal(true),
  },
  closed,
);
export const SaveRelationSchema = Type.Object(
  {
    ...VersionOperationSchema.properties,
    ...RelationInputSchema.properties,
    confirmed: Type.Literal(true),
  },
  closed,
);
export const RestoreVersionSchema = Type.Object(
  {
    ...VersionOperationSchema.properties,
    version: Type.Integer({ minimum: 1 }),
  },
  closed,
);
export const ImportMarkdownSchema = Type.Object(
  {
    ...OperationSchema.properties,
    filename: Type.String({ maxLength: 250 }),
    text: Type.String({ maxLength: 1_100_000 }),
  },
  closed,
);
export const BackupSchema = Type.Object(
  {
    format: Type.Literal('dayzero-knowledge'),
    schemaVersion: Type.Literal(1),
    exportedAt: Timestamp,
    nodes: Type.Array(NodeSchema, { maxItems: 10000 }),
    drafts: Type.Array(DraftSchema, { maxItems: 10000 }),
    relations: Type.Array(RelationSchema, { maxItems: 100000 }),
    revisions: Type.Array(RevisionSchema, { maxItems: 50000 }),
    confirmations: Type.Array(ConfirmationSchema, { maxItems: 100000 }),
    events: Type.Array(EventSchema, { maxItems: 100000 }),
  },
  closed,
);
export type KnowledgeBackup = Static<typeof BackupSchema>;
export const RestoreBackupSchema = Type.Object(
  {
    ...OperationSchema.properties,
    confirmed: Type.Literal(true),
    backup: BackupSchema,
  },
  closed,
);
export const ProfileInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    purpose: Type.Union([Type.Literal('chat'), Type.Literal('embedding')]),
    baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
    modelId: Type.String({ minLength: 1, maxLength: 200 }),
    apiKey: Type.Optional(Type.String({ maxLength: 8192 })),
    clearKey: Type.Optional(Type.Boolean()),
  },
  closed,
);
export type ProfileInput = Static<typeof ProfileInputSchema>;
export type ModelProfile = Omit<ProfileInput, 'apiKey' | 'clearKey'> & {
  id: string;
  keyConfigured: boolean;
  updatedAt: string;
};
