-- Playbooks (RELEASED_UPDATES=playbooks). Migrations run on every start, so keep statements idempotent.
BEGIN;
-- A Playbook is an approved AI task: the name, description, prompt template and field labels
-- are sealed together in definition_enc. Model, answer length and price ceiling stay in clear
-- so the ledger path can enforce them.
CREATE TABLE IF NOT EXISTS playbooks (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), definition_enc text NOT NULL,
 model text NOT NULL, max_tokens int NOT NULL CHECK(max_tokens BETWEEN 1 AND 8192),
 max_pico numeric(78,0) NOT NULL CHECK(max_pico>0), starter text,
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','archived')), version int NOT NULL DEFAULT 1,
 created_by text NOT NULL, updated_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- One row per run attempt. Status, cost, receipt and the sealed answer come from the linked
-- ledger request; this row keeps the sealed inputs and any refusal that happened before billing.
CREATE TABLE IF NOT EXISTS playbook_runs (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), playbook_id text NOT NULL REFERENCES playbooks(id),
 playbook_version int NOT NULL, request_id text NOT NULL, account_id text NOT NULL, seat_id text NOT NULL,
 status text NOT NULL CHECK(status IN('running','blocked','failed')), ceiling_pico numeric(78,0) NOT NULL,
 quoted_pico numeric(78,0), inputs_enc text NOT NULL, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(office_id,request_id)
);
CREATE INDEX IF NOT EXISTS playbook_office ON playbooks(office_id,status,updated_at);
CREATE INDEX IF NOT EXISTS playbook_run_recent ON playbook_runs(office_id,playbook_id,created_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['playbooks','playbook_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS office_isolation ON %I', t);
  EXECUTE format('CREATE POLICY office_isolation ON %I TO chancery_office USING (office_id = current_setting(''chancery.office_id'', true)) WITH CHECK (office_id = current_setting(''chancery.office_id'', true))', t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO chancery_office', t);
 END LOOP;
END $$;
INSERT INTO chancery_schema(version) VALUES(5) ON CONFLICT DO NOTHING;
COMMIT;
