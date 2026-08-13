BEGIN;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS conversation_id text REFERENCES conversations(id);
CREATE SEQUENCE IF NOT EXISTS message_order_seq;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ordinal bigint NOT NULL DEFAULT nextval('message_order_seq');
GRANT USAGE ON SEQUENCE message_order_seq TO chancery_office;
CREATE INDEX IF NOT EXISTS conversation_requests ON requests(office_id,conversation_id,created_at);
CREATE INDEX IF NOT EXISTS message_conversation ON messages(office_id,conversation_id,created_at);
INSERT INTO chancery_schema(version) VALUES(4) ON CONFLICT DO NOTHING;
COMMIT;
