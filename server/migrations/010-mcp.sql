BEGIN;
CREATE TABLE IF NOT EXISTS mcp_connections (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id),
 account_id text NOT NULL REFERENCES accounts(id), name text NOT NULL,
 token_hash text UNIQUE NOT NULL, scopes jsonb NOT NULL, role_at_creation text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, last_used_at timestamptz
);
CREATE TABLE IF NOT EXISTS mcp_drafts (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id),
 connection_id text NOT NULL REFERENCES mcp_connections(id), account_id text NOT NULL REFERENCES accounts(id),
 request_enc text NOT NULL, request_hash text NOT NULL, client_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 UNIQUE(connection_id,client_id)
);
ALTER TABLE mcp_drafts ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE TABLE IF NOT EXISTS mcp_rate_limits (
 key text PRIMARY KEY, count int NOT NULL, expires_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_rate_limits TO chancery_service;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['mcp_connections','mcp_drafts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS office_isolation ON %I', t);
  EXECUTE format('CREATE POLICY office_isolation ON %I TO chancery_office USING (office_id=current_setting(''chancery.office_id'',true)) WITH CHECK (office_id=current_setting(''chancery.office_id'',true))', t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO chancery_office',t);
 END LOOP;
END $$;
DROP POLICY IF EXISTS service_token_lookup ON mcp_connections;
CREATE POLICY service_token_lookup ON mcp_connections FOR SELECT TO chancery_service USING (true);
GRANT SELECT ON mcp_connections TO chancery_service;
CREATE INDEX IF NOT EXISTS mcp_draft_account ON mcp_drafts(office_id,account_id,created_at);
CREATE INDEX IF NOT EXISTS mcp_rate_expiry ON mcp_rate_limits(expires_at);
INSERT INTO chancery_schema(version) VALUES(10) ON CONFLICT DO NOTHING;
COMMIT;
