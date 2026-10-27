CREATE SCHEMA knowledge;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE knowledge.operations (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge.confirmations (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  entity_kind text NOT NULL CHECK (entity_kind IN ('node', 'relation')),
  entity_id uuid NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge.nodes (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  markdown text NOT NULL DEFAULT '',
  aliases text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  sources text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  position double precision[] NOT NULL CHECK (array_length(position, 1) = 3),
  confirmation_id uuid NOT NULL REFERENCES knowledge.confirmations(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_text text GENERATED ALWAYS AS (title || E'\n' || markdown) STORED
);
CREATE INDEX node_search ON knowledge.nodes USING gin (search_text gin_trgm_ops);
CREATE TABLE knowledge.drafts (
  id uuid PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  markdown text NOT NULL DEFAULT '',
  aliases text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  sources text[] NOT NULL DEFAULT '{}',
  links jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  committed_node_id uuid UNIQUE REFERENCES knowledge.nodes(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge.relations (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES knowledge.nodes(id),
  target_id uuid NOT NULL REFERENCES knowledge.nodes(id),
  type text NOT NULL CHECK (type IN ('related', 'prerequisite', 'part_of', 'used_for', 'contrast')),
  description text NOT NULL DEFAULT '',
  confirmation_id uuid NOT NULL REFERENCES knowledge.confirmations(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted_at timestamptz,
  deleted_by_node uuid REFERENCES knowledge.nodes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id),
  CHECK (type NOT IN ('related','contrast') OR source_id < target_id)
);
CREATE UNIQUE INDEX active_relation ON knowledge.relations(source_id, target_id, type) WHERE deleted_at IS NULL;
CREATE INDEX relation_source ON knowledge.relations(source_id);
CREATE INDEX relation_target ON knowledge.relations(target_id);
CREATE TABLE knowledge.node_revisions (
  node_id uuid NOT NULL REFERENCES knowledge.nodes(id),
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id, revision)
);
CREATE TABLE knowledge.events (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  entity_kind text NOT NULL CHECK (entity_kind IN ('node','draft','relation')),
  entity_id uuid NOT NULL,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_entity ON knowledge.events(entity_kind, entity_id, created_at);
CREATE TABLE knowledge.outbox (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES knowledge.operations(id) DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  enqueued_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_outbox ON knowledge.outbox(created_at) WHERE enqueued_at IS NULL;
CREATE TABLE knowledge.event_receipts (
  event_id uuid PRIMARY KEY REFERENCES knowledge.outbox(id),
  delivered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge.model_profiles (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('chat','embedding')),
  base_url text NOT NULL,
  model_id text NOT NULL,
  encrypted_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
