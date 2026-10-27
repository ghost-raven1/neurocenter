/** A separate guard keeps migration34's immutable receipt function and historical results unchanged. */
export const CHAT_SUMMARY_POLICY_GUARD_BODY = `
BEGIN
 IF NEW.summary_policy IS DISTINCT FROM OLD.summary_policy THEN RAISE EXCEPTION 'Discussion summary policy is immutable'; END IF;
 RETURN NEW;
END `;

export const CHAT_SUMMARY_POLICY_SCHEMA_SQL = `
ALTER TABLE model_chat_discussions ADD COLUMN summary_policy text NOT NULL DEFAULT 'legacy'
 CHECK(summary_policy IN ('legacy','unique-v1'));
CREATE FUNCTION neurocenter_chat_summary_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $summary_policy$${CHAT_SUMMARY_POLICY_GUARD_BODY}$summary_policy$;
CREATE TRIGGER model_chat_summary_policy_immutable BEFORE UPDATE OF summary_policy ON model_chat_discussions
 FOR EACH ROW EXECUTE FUNCTION neurocenter_chat_summary_policy_immutable();
`;
