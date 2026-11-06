-- Side by Side (RELEASED_UPDATES=side_by_side). Migrations run on every start, so keep statements idempotent.
-- Each comparison keeps its prompt, the billed request for every column and the favourite in one sealed body.
BEGIN;
CREATE TABLE IF NOT EXISTS comparisons (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL,
 body_enc text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comparison_recent ON comparisons(office_id,account_id,created_at);
ALTER TABLE comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparisons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_isolation ON comparisons;
CREATE POLICY office_isolation ON comparisons TO chancery_office USING (office_id=current_setting('chancery.office_id',true)) WITH CHECK (office_id=current_setting('chancery.office_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON comparisons TO chancery_office;
INSERT INTO chancery_schema(version) VALUES(6) ON CONFLICT DO NOTHING;
COMMIT;
