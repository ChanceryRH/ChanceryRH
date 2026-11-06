-- Office Files (RELEASED_UPDATES=office_files). Migrations run on every start, so keep statements idempotent.
-- File names, file contents, questions and answers are sealed with the Office storage key; only sizes and
-- timestamps are stored in the clear.
BEGIN;
CREATE TABLE IF NOT EXISTS office_files (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id),
 name_enc text NOT NULL, content_enc text NOT NULL, size_bytes int NOT NULL CHECK(size_bytes>0),
 uploaded_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS office_file_questions (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL,
 request_id text NOT NULL UNIQUE, record_enc text NOT NULL, model text NOT NULL,
 charged_usd text, receipt_id text, created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['office_files','office_file_questions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS office_isolation ON %I', t);
  EXECUTE format('CREATE POLICY office_isolation ON %I TO chancery_office USING (office_id = current_setting(''chancery.office_id'', true)) WITH CHECK (office_id = current_setting(''chancery.office_id'', true))', t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO chancery_office', t);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS office_files_by_office ON office_files(office_id,created_at);
CREATE INDEX IF NOT EXISTS office_file_questions_by_office ON office_file_questions(office_id,created_at);
INSERT INTO chancery_schema(version) VALUES(9) ON CONFLICT DO NOTHING;
COMMIT;
