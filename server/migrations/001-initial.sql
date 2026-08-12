BEGIN;
CREATE TABLE IF NOT EXISTS chancery_schema (version int PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now());
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='chancery_office') THEN CREATE ROLE chancery_office NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
GRANT chancery_office TO CURRENT_USER;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='chancery_service') THEN CREATE ROLE chancery_service NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
GRANT chancery_office TO chancery_service;
GRANT chancery_service TO CURRENT_USER;

CREATE TABLE IF NOT EXISTS accounts (
 id text PRIMARY KEY, wallet text UNIQUE, credential text UNIQUE NOT NULL, handle text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_challenges (
 id text PRIMARY KEY, kind text NOT NULL, account_id text REFERENCES accounts(id), binding_hash text NOT NULL,
 payload jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 token_hash text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), csrf_hash text NOT NULL,
 expires_at timestamptz NOT NULL, authenticated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS passkeys (
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), public_key text NOT NULL,
 counter bigint NOT NULL, transports jsonb NOT NULL DEFAULT '[]', backed_up boolean NOT NULL,
 failures int NOT NULL DEFAULT 0, locked_until timestamptz, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS offices (
 id text PRIMARY KEY, safe text UNIQUE NOT NULL, name text NOT NULL, chain_id int NOT NULL DEFAULT 4663,
 registry text NOT NULL, delegate text NOT NULL, seat_root text NOT NULL, policy_hash text NOT NULL, policy jsonb NOT NULL,
 cap_pico numeric(78,0) NOT NULL CHECK(cap_pico>=0), status text NOT NULL DEFAULT 'pending',
 owners jsonb NOT NULL DEFAULT '[]', threshold int NOT NULL DEFAULT 1, chain_block text,
 created_at timestamptz NOT NULL DEFAULT now(), synced_at timestamptz
);
-- ACL rows are used only to locate Offices for the authenticated account; tenant data uses RLS below.
CREATE TABLE IF NOT EXISTS office_access (
 office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL REFERENCES accounts(id),
 PRIMARY KEY(office_id, account_id)
);
CREATE TABLE IF NOT EXISTS receipt_keys (id text PRIMARY KEY, public_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS deployment_records (id text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS office_locks (office_id text PRIMARY KEY REFERENCES offices(id));

CREATE TABLE IF NOT EXISTS seats (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text REFERENCES accounts(id),
 credential text NOT NULL, role text NOT NULL CHECK(role IN('principal','officer','member','guest')),
 monthly_cap_pico numeric(78,0) NOT NULL CHECK(monthly_cap_pico>=0), expires_at timestamptz, revoked_at timestamptz,
 status text NOT NULL DEFAULT 'pending', leaf text NOT NULL, approved_root text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(office_id,credential), UNIQUE(office_id,account_id)
);
CREATE TABLE IF NOT EXISTS invites (
 token_hash text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), role text NOT NULL,
 monthly_cap_pico numeric(78,0) NOT NULL, expires_at timestamptz NOT NULL, claimed_by text,
 room_id text, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS office_proposals (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), kind text NOT NULL,
 safe_tx jsonb NOT NULL, payload jsonb NOT NULL, safe_tx_hash text NOT NULL, nonce text NOT NULL,
 status text NOT NULL DEFAULT 'pending', tx_hash text, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS safe_signatures (
 office_id text NOT NULL REFERENCES offices(id), proposal_id text NOT NULL REFERENCES office_proposals(id),
 owner text NOT NULL, signature text NOT NULL, PRIMARY KEY(proposal_id, owner)
);
CREATE TABLE IF NOT EXISTS conversations (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL,
 title_enc text, ephemeral boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), conversation_id text NOT NULL REFERENCES conversations(id),
 account_id text NOT NULL, role text NOT NULL, content_enc text NOT NULL, model text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requests (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL, actor_id text NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN('seat','clerk')), room_id text, model text NOT NULL, lane text NOT NULL,
 request_hash text NOT NULL, status text NOT NULL, reserved_pico numeric(78,0) NOT NULL CHECK(reserved_pico>=0),
 provider_pico numeric(78,0), fee_pico numeric(78,0), charged_pico numeric(78,0), period_start bigint NOT NULL,
 response_enc text, receipt_id text, provider_id text, error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(office_id,id)
);
CREATE TABLE IF NOT EXISTS receipts (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), request_id text UNIQUE REFERENCES requests(id),
 actor_id text NOT NULL, actor_kind text NOT NULL, room_id text, model text NOT NULL, lane text NOT NULL,
 charged_pico numeric(78,0) NOT NULL CHECK(charged_pico>=0), envelope jsonb NOT NULL, leaf text NOT NULL,
 settlement_id text, anchor_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settlements (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), actor_id text NOT NULL, delegate text NOT NULL,
 day bigint NOT NULL, period_start bigint NOT NULL, amount_usdg numeric(78,0) NOT NULL,
 receipt_root text NOT NULL, receipt_ids jsonb NOT NULL, receipt_count int NOT NULL,
 status text NOT NULL DEFAULT 'prepared', tx_hash text, error_code text, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz
);
CREATE TABLE IF NOT EXISTS receipt_anchors (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), hour bigint NOT NULL, root text NOT NULL,
 receipt_ids jsonb NOT NULL, status text NOT NULL DEFAULT 'prepared', tx_hash text, UNIQUE(office_id,hour)
);
CREATE TABLE IF NOT EXISTS seat_charges (
 office_id text NOT NULL REFERENCES offices(id), seat_id text NOT NULL, day bigint NOT NULL, receipt_id text NOT NULL,
 PRIMARY KEY(office_id,seat_id,day)
);
CREATE TABLE IF NOT EXISTS devices (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL,
 public_key jsonb NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rooms (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), name_enc text NOT NULL,
 epoch int NOT NULL DEFAULT 1, retention_days int NOT NULL DEFAULT 30, lane_policy text NOT NULL DEFAULT 'standard',
 rotation_required boolean NOT NULL DEFAULT false, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS room_members (
 office_id text NOT NULL REFERENCES offices(id), room_id text NOT NULL REFERENCES rooms(id), account_id text NOT NULL,
 expires_at timestamptz, removed_at timestamptz, PRIMARY KEY(room_id,account_id)
);
CREATE TABLE IF NOT EXISTS room_keys (
 office_id text NOT NULL REFERENCES offices(id), room_id text NOT NULL REFERENCES rooms(id), epoch int NOT NULL,
 device_id text NOT NULL REFERENCES devices(id), wrapped_key jsonb NOT NULL, PRIMARY KEY(room_id,epoch,device_id)
);
CREATE TABLE IF NOT EXISTS room_items (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), room_id text NOT NULL REFERENCES rooms(id),
 epoch int NOT NULL, account_id text NOT NULL, ciphertext text NOT NULL, nonce text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS clerks (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), name text NOT NULL, job_enc text NOT NULL,
 delegate text, monthly_cap_pico numeric(78,0) NOT NULL, rulebook jsonb NOT NULL, model text NOT NULL,
 status text NOT NULL DEFAULT 'pending', schedule_minutes int, next_run_at timestamptz, room_id text,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS approvals (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), clerk_id text NOT NULL REFERENCES clerks(id),
 request_hash text NOT NULL, request_enc text NOT NULL, max_cost_pico numeric(78,0) NOT NULL,
 status text NOT NULL DEFAULT 'pending', decided_by text, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS minutes (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), room_id text, body_enc text,
 body_hash text NOT NULL, envelope jsonb NOT NULL, tx_hash text, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS roadmap_votes (
 office_id text NOT NULL REFERENCES offices(id), topic text NOT NULL, choice text NOT NULL, signer text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(office_id,topic)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), actor_id text NOT NULL,
 action text NOT NULL, reference text, created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['office_locks','seats','invites','office_proposals','safe_signatures','conversations','messages','requests','receipts','settlements','receipt_anchors','seat_charges','devices','rooms','room_members','room_keys','room_items','clerks','approvals','minutes','roadmap_votes','audit_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS office_isolation ON %I', t);
  EXECUTE format('CREATE POLICY office_isolation ON %I TO chancery_office USING (office_id = current_setting(''chancery.office_id'', true)) WITH CHECK (office_id = current_setting(''chancery.office_id'', true))', t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO chancery_office', t);
 END LOOP;
END $$;
ALTER TABLE offices ENABLE ROW LEVEL SECURITY;
ALTER TABLE offices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_metadata ON offices;
CREATE POLICY office_metadata ON offices TO chancery_office USING (id=current_setting('chancery.office_id',true));
DROP POLICY IF EXISTS service_metadata ON offices;
CREATE POLICY service_metadata ON offices TO chancery_service USING (true) WITH CHECK (true);
GRANT SELECT ON offices, receipt_keys TO chancery_office;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts,auth_challenges,auth_sessions,passkeys,offices,office_access,receipt_keys,deployment_records TO chancery_service;
GRANT SELECT ON chancery_schema TO chancery_service;
CREATE INDEX IF NOT EXISTS request_budget ON requests(office_id,actor_id,created_at,status);
CREATE INDEX IF NOT EXISTS receipt_unsettled ON receipts(office_id,actor_id,settlement_id,created_at);
CREATE INDEX IF NOT EXISTS room_item_expiry ON room_items(expires_at);
INSERT INTO chancery_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;
