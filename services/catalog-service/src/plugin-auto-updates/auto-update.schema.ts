/** Migration41 owns policy metadata only; installation and recovery remain in the existing bridge queue. */
export const PLUGIN_AUTO_UPDATE_SCHEMA_SQL = `
CREATE TABLE plugin_auto_update_policies (
 id uuid PRIMARY KEY,owner_email text NOT NULL,actor_role text NOT NULL,
 device_id text NOT NULL REFERENCES bridge_devices(id) ON DELETE CASCADE,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,binding_id text NOT NULL CHECK(binding_id~'^[a-f0-9]{64}$'),
 asset_id text NOT NULL,enabled boolean NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('disabled','waiting','up-to-date','queued','succeeded','attention')),
 message text NOT NULL CHECK(octet_length(message)<=4096),next_check_at timestamptz,checked_at timestamptz,
 mutation_key uuid NOT NULL,mutation_hash text NOT NULL CHECK(mutation_hash~'^[a-f0-9]{64}$'),
 pending_input jsonb CHECK(pending_input IS NULL OR jsonb_typeof(pending_input)='object' AND octet_length(pending_input::text)<=16384),
 pending_role text,CHECK((pending_input IS NULL)=(pending_role IS NULL)),
 job_id text REFERENCES bridge_jobs(id),lease_token uuid,lease_until timestamptz,
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 UNIQUE(owner_email,device_id,project_id,binding_id,asset_id)
);
CREATE INDEX plugin_auto_update_due ON plugin_auto_update_policies(next_check_at) WHERE enabled;
CREATE FUNCTION plugin_auto_update_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $auto_update$
BEGIN
 IF ROW(NEW.id,NEW.owner_email,NEW.device_id,NEW.project_id,NEW.binding_id,NEW.asset_id) IS DISTINCT FROM
    ROW(OLD.id,OLD.owner_email,OLD.device_id,OLD.project_id,OLD.binding_id,OLD.asset_id)
 THEN RAISE EXCEPTION 'Plugin auto update identity is immutable'; END IF;
 RETURN NEW;
END $auto_update$;
CREATE TRIGGER plugin_auto_update_identity_guard BEFORE UPDATE ON plugin_auto_update_policies FOR EACH ROW EXECUTE FUNCTION plugin_auto_update_identity_guard();
`;
