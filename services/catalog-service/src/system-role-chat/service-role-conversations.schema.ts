/** Migration43 adds role pins without rewriting old dialogs or immutable request receipts. */
export const SERVICE_ROLE_CONVERSATIONS_SCHEMA_SQL = `
ALTER TABLE system_role_dialogs ADD COLUMN agent_id text CHECK(agent_id IN ('agent-coordinator','agent-ai-admin','agent-autoconfigurator','agent-indexer','agent-packager'));
CREATE INDEX system_role_dialog_role_history ON system_role_dialogs(owner_email,project_id,agent_id,updated_at DESC,id DESC);
CREATE FUNCTION service_role_conversation_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $pin$
BEGIN
 IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN RAISE EXCEPTION 'System role conversation pin is immutable'; END IF;
 RETURN NEW;
END $pin$;
CREATE TRIGGER service_role_conversation_pin_guard BEFORE UPDATE OF agent_id ON system_role_dialogs FOR EACH ROW EXECUTE FUNCTION service_role_conversation_pin_guard();
CREATE FUNCTION service_role_conversation_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $intent$
BEGIN
 IF EXISTS(SELECT 1 FROM system_role_dialogs d WHERE d.id=NEW.dialog_id AND d.owner_email=NEW.owner_email AND d.agent_id IS NOT NULL AND d.agent_id<>NEW.agent_id) THEN
  RAISE EXCEPTION 'System role conversation recipient mismatch';
 END IF;
 RETURN NEW;
END $intent$;
CREATE TRIGGER service_role_conversation_intent_guard BEFORE INSERT ON system_role_dialog_intents FOR EACH ROW EXECUTE FUNCTION service_role_conversation_intent_guard();
`;
