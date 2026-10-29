CREATE TABLE knowledge.ingestion_runs (
 id uuid PRIMARY KEY,
 draft_id uuid NOT NULL REFERENCES knowledge.drafts(id),
 draft_revision integer NOT NULL,
 workflow_version text NOT NULL DEFAULT 'm2-v1',
 chat_profile_id uuid NOT NULL,
 embedding_profile_id uuid NOT NULL,
 chat_version text NOT NULL,
 embedding_version text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','review','committing','committed','failed','cancelled','stale')),
 stage text NOT NULL DEFAULT 'queued',
 parsed jsonb,
 candidates jsonb,
 proposals jsonb,
 decision jsonb,
 review_version integer NOT NULL DEFAULT 0,
 commit_operation_id uuid NOT NULL UNIQUE,
 result_node_id uuid REFERENCES knowledge.nodes(id),
 error text,
 progress jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ingestion_one_active_draft ON knowledge.ingestion_runs(draft_id) WHERE status IN ('queued','processing','review','committing');
CREATE INDEX ingestion_pending ON knowledge.ingestion_runs(updated_at) WHERE status IN ('queued','processing','committing');
CREATE TABLE knowledge.model_calls (
 id uuid PRIMARY KEY,
 run_id uuid REFERENCES knowledge.ingestion_runs(id),
 profile_id uuid NOT NULL,
 purpose text NOT NULL,
 cache_key text,
 duration_ms integer NOT NULL,
 usage jsonb,
 status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge.ingestion_steps (
 run_id uuid NOT NULL REFERENCES knowledge.ingestion_runs(id),
 step text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(run_id,step)
);
CREATE TABLE knowledge.node_chunks (
 node_id uuid NOT NULL REFERENCES knowledge.nodes(id),
 node_revision integer NOT NULL,
 profile_version text NOT NULL,
 ordinal integer NOT NULL,
 content_hash text NOT NULL,
 text text NOT NULL,
 start_line integer NOT NULL,
 end_line integer NOT NULL,
 dimensions integer NOT NULL,
 embedding vector NOT NULL,
 PRIMARY KEY(node_id,node_revision,profile_version,ordinal),
 CHECK(vector_dims(embedding)=dimensions)
);
CREATE INDEX node_chunks_profile ON knowledge.node_chunks(profile_version,dimensions);
