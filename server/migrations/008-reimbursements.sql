-- Reimbursements (RELEASED_UPDATES=reimbursements). Migrations run on every start, so keep statements idempotent.
BEGIN;
-- Vendor, note, receipt image and rejection reason are sealed per Office. Amounts stay in clear for totals and balance checks.
CREATE TABLE IF NOT EXISTS reimbursements (
 id text PRIMARY KEY, office_id text NOT NULL REFERENCES offices(id), account_id text NOT NULL,
 payout_wallet text NOT NULL, amount_units numeric(78,0) NOT NULL CHECK(amount_units>0),
 category text NOT NULL, spent_on date NOT NULL, details_enc text NOT NULL, receipt_enc text,
 status text NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','approved','paid','rejected','withdrawn')),
 proposal_id text, reviewed_by text, reviewed_at timestamptz, reason_enc text, tx_hash text, paid_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reimbursements ENABLE ROW LEVEL SECURITY;
ALTER TABLE reimbursements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_isolation ON reimbursements;
CREATE POLICY office_isolation ON reimbursements TO chancery_office USING (office_id = current_setting('chancery.office_id', true)) WITH CHECK (office_id = current_setting('chancery.office_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursements TO chancery_office;
CREATE INDEX IF NOT EXISTS reimbursement_status ON reimbursements(office_id,status,created_at);
CREATE INDEX IF NOT EXISTS reimbursement_account ON reimbursements(office_id,account_id,created_at);
INSERT INTO chancery_schema(version) VALUES(8) ON CONFLICT DO NOTHING;
COMMIT;
