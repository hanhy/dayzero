CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS m0;

-- Isolated proof data; never treated as the user's knowledge graph.
CREATE TABLE m0.workflow_commits (
  operation_id text PRIMARY KEY,
  node_id uuid NOT NULL UNIQUE,
  title text NOT NULL,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE m0.outbox (
  operation_id text PRIMARY KEY REFERENCES m0.workflow_commits(operation_id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
