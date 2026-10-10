CREATE TABLE IF NOT EXISTS google_connection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  refresh_token text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mcp_clients (
  id uuid PRIMARY KEY, name text NOT NULL, token_hash text NOT NULL UNIQUE,
  can_write boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS root_grants (
  client_id uuid REFERENCES mcp_clients(id) ON DELETE CASCADE,
  folder_id text NOT NULL, name text NOT NULL, can_write boolean NOT NULL DEFAULT false,
  PRIMARY KEY (client_id, folder_id)
);
CREATE TABLE IF NOT EXISTS operations (
  client_id uuid REFERENCES mcp_clients(id), operation_id text NOT NULL,
  digest text NOT NULL, state text NOT NULL CHECK (state IN ('pending','succeeded','unknown')),
  result jsonb, generated_id text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, operation_id)
);
CREATE TABLE IF NOT EXISTS transfers (
  id uuid PRIMARY KEY, client_id uuid REFERENCES mcp_clients(id),
  kind text NOT NULL CHECK (kind IN ('upload','download')),
  data jsonb NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id uuid REFERENCES mcp_clients(id), tool text NOT NULL,
  outcome text NOT NULL, code text, duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_states (
  hash text PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events(created_at DESC);
CREATE TABLE IF NOT EXISTS delegated_sessions (
  token_hash text PRIMARY KEY, client_id uuid REFERENCES mcp_clients(id),
  tools text[] NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS login_limits (
  key text PRIMARY KEY, attempts integer NOT NULL, started_at timestamptz NOT NULL
);
