BEGIN;
CREATE TABLE IF NOT EXISTS productivity_items (
 id text NOT NULL, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL REFERENCES accounts(id),
 kind text NOT NULL, value_enc text NOT NULL, version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(office_id,account_id,kind,id)
);
ALTER TABLE productivity_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE productivity_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_isolation ON productivity_items;
CREATE POLICY office_isolation ON productivity_items TO chancery_office
 USING (office_id=current_setting('chancery.office_id',true))
 WITH CHECK (office_id=current_setting('chancery.office_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON productivity_items TO chancery_office;
CREATE INDEX IF NOT EXISTS productivity_personal ON productivity_items(office_id,account_id,kind,updated_at DESC);
INSERT INTO chancery_schema(version) VALUES(11) ON CONFLICT DO NOTHING;
COMMIT;
