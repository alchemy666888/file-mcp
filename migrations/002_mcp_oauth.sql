-- Additive migration: existing Google connections and bearer clients are preserved.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id text PRIMARY KEY, name text NOT NULL,
  parent_id uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  redirect_uris text[] NOT NULL, auth_method text NOT NULL
    CHECK (auth_method IN ('none','client_secret_basic','client_secret_post')),
  secret_hash text, revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((auth_method = 'none') = (secret_hash IS NULL))
);
CREATE TABLE IF NOT EXISTS mcp_oauth_requests (
  id text PRIMARY KEY, client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, challenge text NOT NULL, scope text NOT NULL,
  resource text NOT NULL, state text, browser_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id uuid PRIMARY KEY, client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  scope text NOT NULL, resource text NOT NULL, roots jsonb NOT NULL,
  tools text[] NOT NULL, revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, challenge text NOT NULL, expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  expires_at timestamptz NOT NULL, used boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_requests_expiry ON mcp_oauth_requests(expires_at);
CREATE TABLE IF NOT EXISTS mcp_oauth_limits (
  key text PRIMARY KEY, attempts integer NOT NULL, started_at timestamptz NOT NULL
);
