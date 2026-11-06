BEGIN;
ALTER TABLE transaction_outbox ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS transaction_attempts (
 transaction_hash text PRIMARY KEY, outbox_id text NOT NULL REFERENCES transaction_outbox(id),
 raw_enc text NOT NULL, status text NOT NULL CHECK(status='failed'), confirmed_at timestamptz NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT ON transaction_attempts TO chancery_service;
INSERT INTO chancery_schema(version) VALUES(15) ON CONFLICT DO NOTHING;
COMMIT;
