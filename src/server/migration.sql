CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  state jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('analyst','manager','warehouse','procurement','admin','viewer')),
  org_id text NOT NULL,
  password_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_users(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS session_user_idx ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS session_expiry_idx ON app_sessions(expires_at);

CREATE TABLE IF NOT EXISTS suppliers (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_workspace_idx ON suppliers(workspace_id);

CREATE TABLE IF NOT EXISTS warehouses (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  capacity integer NOT NULL CHECK (capacity >= 0),
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS warehouse_workspace_idx ON warehouses(workspace_id);

CREATE TABLE IF NOT EXISTS shipments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  supplier_id text NOT NULL REFERENCES suppliers(id),
  warehouse_id text NOT NULL REFERENCES warehouses(id),
  quantity integer NOT NULL CHECK (quantity >= 0),
  eta timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS shipment_workspace_idx ON shipments(workspace_id);
CREATE INDEX IF NOT EXISTS shipment_supplier_idx ON shipments(supplier_id);
CREATE INDEX IF NOT EXISTS shipment_warehouse_idx ON shipments(warehouse_id);

CREATE TABLE IF NOT EXISTS inventory_lots (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  warehouse_id text NOT NULL REFERENCES warehouses(id),
  item_id text NOT NULL,
  quantity integer NOT NULL CHECK(quantity >= 0),
  reserved integer NOT NULL CHECK(reserved >= 0 AND reserved <= quantity),
  status text NOT NULL CHECK(status IN ('available','held','disputed')),
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS lot_workspace_idx ON inventory_lots(workspace_id);
CREATE INDEX IF NOT EXISTS lot_warehouse_item_idx ON inventory_lots(warehouse_id, item_id);

CREATE TABLE IF NOT EXISTS customer_orders (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  warehouse_id text NOT NULL REFERENCES warehouses(id),
  deadline timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS order_workspace_idx ON customer_orders(workspace_id);
CREATE INDEX IF NOT EXISTS order_warehouse_deadline_idx ON customer_orders(warehouse_id, deadline);

CREATE TABLE IF NOT EXISTS order_lines (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES customer_orders(id),
  item_id text NOT NULL,
  quantity integer NOT NULL CHECK(quantity > 0),
  fulfilled integer NOT NULL CHECK(fulfilled >= 0 AND fulfilled <= quantity)
);
CREATE INDEX IF NOT EXISTS line_order_idx ON order_lines(order_id);

-- Idempotent schema upgrades for existing databases
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'inventory_lots') THEN
    UPDATE inventory_lots SET status = 'held' WHERE status = 'quarantined';
    ALTER TABLE inventory_lots DROP CONSTRAINT IF EXISTS inventory_lots_status_check;
    ALTER TABLE inventory_lots ADD CONSTRAINT inventory_lots_status_check CHECK (status IN ('available','held','disputed'));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'app_users') THEN
    ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
    ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('analyst','manager','warehouse','procurement','admin','viewer'));
  END IF;
END $$;

-- Integration health and continuity inbox tables
CREATE TABLE IF NOT EXISTS integration_connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK (kind IN ('carrier','warehouse','supplier','document','ai')),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('online','degraded','offline','recovering')),
  reason text,
  failure_count integer NOT NULL DEFAULT 0,
  circuit_open_until timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS integration_conn_ws_idx ON integration_connections(workspace_id);

CREATE TABLE IF NOT EXISTS integration_inbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  integration_id text NOT NULL REFERENCES integration_connections(id),
  source_event_id text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  source_sequence integer,
  correlation_id text,
  payload jsonb NOT NULL,
  event_time timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('pending','processing','processed','failed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  replay_lineage jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS inbox_ws_idx ON integration_inbox(workspace_id);
CREATE INDEX IF NOT EXISTS inbox_integration_idx ON integration_inbox(integration_id);
CREATE INDEX IF NOT EXISTS inbox_pending_idx ON integration_inbox(next_attempt_at, id) WHERE status IN ('pending', 'failed');

-- Document processing tables
CREATE TABLE IF NOT EXISTS document_records (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  filename text NOT NULL,
  file_size_bytes integer NOT NULL,
  page_count integer,
  mime_type text NOT NULL,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('uploading','processing','ready','matched','mismatch','review','confirmed','failed')),
  confidence numeric(4,3) NOT NULL DEFAULT 0.000,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  extracted_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  excerpt text,
  confirmed_by text REFERENCES app_users(id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS doc_records_ws_idx ON document_records(workspace_id);
CREATE INDEX IF NOT EXISTS doc_records_confirmed_by_idx ON document_records(confirmed_by);

CREATE TABLE IF NOT EXISTS document_files (
  id text PRIMARY KEY REFERENCES document_records(id) ON DELETE CASCADE,
  data bytea NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_jobs (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  status text NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_jobs_ws_idx ON document_jobs(workspace_id);
CREATE INDEX IF NOT EXISTS doc_jobs_doc_idx ON document_jobs(document_id);
CREATE INDEX IF NOT EXISTS doc_jobs_pending_idx ON document_jobs(created_at, id) WHERE status IN ('queued', 'failed');

CREATE TABLE IF NOT EXISTS document_chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  page_number integer,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  content text NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_chunks_doc_idx ON document_chunks(document_id, chunk_index);

CREATE TABLE IF NOT EXISTS agent_execution_logs (
  id text PRIMARY KEY,
  timestamp text NOT NULL,
  agent text NOT NULL,
  feature text NOT NULL,
  action text NOT NULL,
  accessed_entities text NOT NULL,
  actor_id text,
  summary text NOT NULL,
  status text NOT NULL,
  latency_ms integer NOT NULL,
  model text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_timestamp ON agent_execution_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_logs_feature ON agent_execution_logs(feature);
