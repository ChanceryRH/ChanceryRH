BEGIN;
CREATE TABLE IF NOT EXISTS worker_leases(id text PRIMARY KEY,owner text NOT NULL,expires_at timestamptz NOT NULL,heartbeat_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS transaction_outbox (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), kind text NOT NULL, reference text NOT NULL,
 transaction_hash text NOT NULL UNIQUE, raw_enc text NOT NULL, status text NOT NULL DEFAULT 'prepared',
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, UNIQUE(kind,reference)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON worker_leases,transaction_outbox TO chancery_service;
INSERT INTO chancery_schema(version) VALUES(3) ON CONFLICT DO NOTHING;
COMMIT;
