-- Documents evolve with the versioned API contract; tenant identity, revisions,
-- uniqueness and query ordering remain relational and transactionally enforced.
CREATE TABLE organizations (
  id text PRIMARY KEY,
  org_id text NOT NULL CHECK (org_id = id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX teams_org_order_idx ON teams (org_id, created_at, id);

CREATE TABLE principals (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX principals_org_order_idx ON principals (org_id, created_at, id);

CREATE TABLE agents (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX agents_org_order_idx ON agents (org_id, created_at, id);

CREATE TABLE manifests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX manifests_org_order_idx ON manifests (org_id, created_at, id);

CREATE TABLE hiring_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX hiring_requests_org_order_idx ON hiring_requests (org_id, created_at, id);

CREATE TABLE approvals (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX approvals_org_order_idx ON approvals (org_id, created_at, id);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX jobs_org_order_idx ON jobs (org_id, created_at, id);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX tasks_org_order_idx ON tasks (org_id, created_at, id);

CREATE TABLE schedules (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX schedules_org_order_idx ON schedules (org_id, created_at, id);

CREATE TABLE messages (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX messages_org_order_idx ON messages (org_id, created_at, id);

CREATE TABLE escalations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX escalations_org_order_idx ON escalations (org_id, created_at, id);

CREATE TABLE grants (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX grants_org_order_idx ON grants (org_id, created_at, id);

CREATE TABLE memory_entries (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX memory_entries_org_order_idx ON memory_entries (org_id, created_at, id);

CREATE TABLE learning_proposals (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX learning_proposals_org_order_idx ON learning_proposals (org_id, created_at, id);

CREATE TABLE evaluations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX evaluations_org_order_idx ON evaluations (org_id, created_at, id);

CREATE TABLE usage_reservations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX usage_reservations_org_order_idx ON usage_reservations (org_id, created_at, id);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX artifacts_org_order_idx ON artifacts (org_id, created_at, id);

CREATE TABLE events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX events_org_order_idx ON events (org_id, created_at, id);

CREATE TABLE idempotency_keys (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX idempotency_keys_org_order_idx ON idempotency_keys (org_id, created_at, id);

-- Retry keys cannot duplicate durable work even under concurrent requests.
CREATE UNIQUE INDEX jobs_idempotency_idx ON jobs (org_id, (data->>'idempotencyKey'))
  WHERE data->>'idempotencyKey' IS NOT NULL;
CREATE INDEX jobs_claim_idx ON jobs ((data->>'status'), (data->>'leaseExpiresAt'), created_at, id);
CREATE UNIQUE INDEX manifests_agent_version_idx ON manifests (org_id, (data->>'agentId'), (data->>'version'));
CREATE INDEX agents_manager_idx ON agents (org_id, (data->>'managerId'));
CREATE INDEX agents_team_idx ON agents (org_id, (data->>'teamId'));
CREATE INDEX tasks_agent_idx ON tasks (org_id, (data->>'agentId'), created_at, id);
CREATE INDEX messages_recipient_idx ON messages (org_id, (data->>'recipientId'), created_at, id);
CREATE INDEX memory_scope_idx ON memory_entries (org_id, (data->>'category'), (data->>'ownerAgentId'), created_at, id);
CREATE INDEX events_agent_idx ON events (org_id, (data->>'agentId'), created_at, id);
CREATE INDEX events_job_idx ON events (org_id, (data->>'jobId'), created_at, id);
CREATE INDEX usage_agent_idx ON usage_reservations (org_id, (data->>'agentId'), created_at, id);
CREATE INDEX hiring_status_idx ON hiring_requests (org_id, (data->>'status'), created_at, id);
CREATE UNIQUE INDEX idempotency_scope_key_idx ON idempotency_keys (org_id, (data->>'scope'), (data->>'key'));

-- Accepted manifests and audit/artifact history cannot be rewritten by a stale attempt.
CREATE FUNCTION reject_immutable_record_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable; create a new version instead', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER manifests_immutable BEFORE UPDATE OR DELETE ON manifests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_record_mutation();

CREATE TABLE resources (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX resources_org_order_idx ON resources (org_id, created_at, id);

CREATE TABLE governance (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX governance_org_order_idx ON governance (org_id, created_at, id);
