/** Dialog intents and accepted role runs commit together; no second runtime or replay queue exists. */
export const SYSTEM_ROLE_CHAT_SCHEMA_SQL = `
CREATE TABLE system_role_dialogs (
 id uuid PRIMARY KEY,owner_email text NOT NULL REFERENCES platform_users(email) ON DELETE CASCADE,
 project_id text REFERENCES projects(id) ON DELETE CASCADE,title text NOT NULL CHECK(length(btrim(title))>0 AND octet_length(title)<=240),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,owner_email)
);
CREATE INDEX system_role_dialog_owner_history ON system_role_dialogs(owner_email,project_id,updated_at DESC,id DESC);
CREATE TABLE system_role_dialog_intents (
 id uuid PRIMARY KEY,dialog_id uuid NOT NULL,owner_email text NOT NULL,request_id uuid NOT NULL CHECK(id=request_id),
 agent_id text NOT NULL CHECK(agent_id IN ('agent-coordinator','agent-ai-admin','agent-autoconfigurator','agent-indexer','agent-packager')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND octet_length(input::text)<=131072),
 run_id uuid UNIQUE REFERENCES system_role_runs(id),cancel_requested boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_email,request_id),FOREIGN KEY(dialog_id,owner_email) REFERENCES system_role_dialogs(id,owner_email) ON DELETE CASCADE
);
CREATE INDEX system_role_dialog_turn_history ON system_role_dialog_intents(dialog_id,owner_email,created_at DESC,id DESC);
CREATE TABLE system_role_dialog_contexts (
 id uuid PRIMARY KEY,dialog_id uuid NOT NULL,owner_email text NOT NULL,
 refs jsonb NOT NULL CHECK(jsonb_typeof(refs)='array' AND jsonb_array_length(refs) BETWEEN 1 AND 5 AND octet_length(refs::text)<=2048),
 pin text NOT NULL CHECK(pin~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(dialog_id,owner_email) REFERENCES system_role_dialogs(id,owner_email) ON DELETE CASCADE
);
CREATE FUNCTION system_role_dialog_guard() RETURNS trigger LANGUAGE plpgsql AS $dialog$
BEGIN
 IF (NEW.id,NEW.owner_email,NEW.project_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_email,OLD.project_id,OLD.created_at)
 THEN RAISE EXCEPTION 'System dialog owner and scope are immutable'; END IF;
 RETURN NEW;
END $dialog$;
CREATE TRIGGER system_role_dialog_guard BEFORE UPDATE ON system_role_dialogs FOR EACH ROW EXECUTE FUNCTION system_role_dialog_guard();
CREATE FUNCTION system_role_dialog_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $intent$
BEGIN
 IF (NEW.id,NEW.dialog_id,NEW.owner_email,NEW.request_id,NEW.agent_id,NEW.request_hash,NEW.input,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.dialog_id,OLD.owner_email,OLD.request_id,OLD.agent_id,OLD.request_hash,OLD.input,OLD.created_at)
 OR OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id OR OLD.cancel_requested AND NOT NEW.cancel_requested
 THEN RAISE EXCEPTION 'System dialog accepted intent is immutable'; END IF;
 RETURN NEW;
END $intent$;
CREATE TRIGGER system_role_dialog_intent_guard BEFORE UPDATE ON system_role_dialog_intents FOR EACH ROW EXECUTE FUNCTION system_role_dialog_intent_guard();
CREATE FUNCTION system_role_dialog_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $receipt$
BEGIN
 IF EXISTS(SELECT 1 FROM system_role_dialog_intents WHERE id=NEW.id) AND NOT EXISTS(
 SELECT 1 FROM system_role_dialog_intents i JOIN system_role_dialogs d ON d.id=i.dialog_id AND d.owner_email=i.owner_email
 JOIN system_role_runs r ON r.id=i.run_id AND r.actor=i.owner_email AND r.agent_id=i.agent_id
 AND r.request_id=i.request_id AND r.request_hash=i.request_hash AND r.request=i.input AND r.project_id IS NOT DISTINCT FROM d.project_id
 WHERE i.id=NEW.id AND i.input->>'sourceFeature'='system_role_chat' AND i.input->'source'->>'kind'='system-role-chat'
 AND i.input->'source'->>'dialogId'=i.dialog_id::text AND i.input->'source'->>'turnId'=i.id::text)
 THEN RAISE EXCEPTION 'System dialog receipt must identify its accepted role run'; END IF;
 RETURN NULL;
END $receipt$;
CREATE CONSTRAINT TRIGGER system_role_dialog_receipt_guard AFTER INSERT OR UPDATE ON system_role_dialog_intents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION system_role_dialog_receipt_guard();
CREATE FUNCTION system_role_dialog_context_guard() RETURNS trigger LANGUAGE plpgsql AS $context$
BEGIN RAISE EXCEPTION 'System dialog context receipt is immutable'; END $context$;
CREATE TRIGGER system_role_dialog_context_guard BEFORE UPDATE ON system_role_dialog_contexts FOR EACH ROW EXECUTE FUNCTION system_role_dialog_context_guard();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON system_role_dialogs FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
`;
