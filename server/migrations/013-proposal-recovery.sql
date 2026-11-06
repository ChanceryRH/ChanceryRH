BEGIN;
ALTER TABLE office_proposals ADD COLUMN IF NOT EXISTS created_block numeric(78,0);
CREATE UNIQUE INDEX IF NOT EXISTS proposal_confirmed_execution ON office_proposals(office_id,safe_tx_hash) WHERE status='confirmed';
GRANT UPDATE(owners,threshold,chain_block,cap_pico,status,synced_at,seat_root,policy,policy_hash) ON offices TO chancery_office;
INSERT INTO chancery_schema(version) VALUES(13) ON CONFLICT DO NOTHING;
COMMIT;
