BEGIN;
ALTER TABLE seats ADD COLUMN IF NOT EXISTS authorization_version bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION bump_seat_authorization_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.credential,OLD.role,OLD.monthly_cap_pico,OLD.expires_at,OLD.status,OLD.revoked_at)
 IS DISTINCT FROM ROW(NEW.credential,NEW.role,NEW.monthly_cap_pico,NEW.expires_at,NEW.status,NEW.revoked_at) THEN
  NEW.authorization_version := OLD.authorization_version + 1;
 ELSE
  NEW.authorization_version := OLD.authorization_version;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS seat_authorization_version ON seats;
CREATE TRIGGER seat_authorization_version BEFORE UPDATE ON seats FOR EACH ROW EXECUTE FUNCTION bump_seat_authorization_version();
INSERT INTO chancery_schema(version) VALUES(16) ON CONFLICT DO NOTHING;
COMMIT;
