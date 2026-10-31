/** Late references cannot bypass durable project retirement. */
export const RETIREMENT_REFERENCE_SCHEMA_SQL = `
CREATE OR REPLACE FUNCTION neurocenter_retired_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.project_id IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||NEW.project_id,0));
            IF EXISTS(SELECT 1 FROM project_retirements WHERE project_id=NEW.project_id) THEN
                RAISE EXCEPTION 'Retired project reference rejected' USING ERRCODE='23514';
            END IF;
        END IF; RETURN NEW;
    END $$;
DROP TRIGGER IF EXISTS neurocenter_retired_reference_guard ON bridge_jobs; CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON bridge_jobs FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
DROP TRIGGER IF EXISTS neurocenter_retired_reference_guard ON bridge_hosted_rag_grants; CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON bridge_hosted_rag_grants FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
`;
