BEGIN;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_by text;
UPDATE approvals SET status='denied' WHERE requested_by IS NULL AND status IN ('pending','approved') AND consumed_at IS NULL;
INSERT INTO chancery_schema(version) VALUES(14) ON CONFLICT DO NOTHING;
COMMIT;
