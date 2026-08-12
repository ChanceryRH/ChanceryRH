BEGIN;
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_request_id_key;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS period_start bigint NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'final';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'usage';
CREATE UNIQUE INDEX IF NOT EXISTS receipt_final_request ON receipts(request_id) WHERE status='final';
CREATE TABLE IF NOT EXISTS quotes (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL,
 request_hash text NOT NULL, maximum_pico numeric(78,0) NOT NULL, envelope jsonb NOT NULL,
 expires_at timestamptz NOT NULL, consumed_by text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_isolation ON quotes;
CREATE POLICY office_isolation ON quotes TO chancery_office USING (office_id=current_setting('chancery.office_id',true)) WITH CHECK (office_id=current_setting('chancery.office_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON quotes TO chancery_office;
INSERT INTO chancery_schema(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
