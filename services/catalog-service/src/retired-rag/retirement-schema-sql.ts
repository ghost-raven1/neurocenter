/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const RETIREMENT_SCHEMA_SQL=`
SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:project-retirement-schema',0));
        CREATE TABLE IF NOT EXISTS project_retirements(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),project_id TEXT NOT NULL UNIQUE,project_name TEXT NOT NULL,
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),actor TEXT NOT NULL,origin TEXT NOT NULL DEFAULT 'deletion',
        retention_revision INTEGER NOT NULL DEFAULT 0,retain_until TIMESTAMPTZ,retention_reason TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS retired_rag_previews(
        id UUID PRIMARY KEY,retirement_id UUID NOT NULL REFERENCES project_retirements(id),digest TEXT NOT NULL,
        facts JSONB NOT NULL,retention_revision INTEGER NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL);
        CREATE TABLE IF NOT EXISTS retired_rag_purges(
        id UUID PRIMARY KEY,retirement_id UUID NOT NULL REFERENCES project_retirements(id),request_key UUID NOT NULL UNIQUE,
        preview_id UUID NOT NULL REFERENCES retired_rag_previews(id),digest TEXT NOT NULL,actor TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','failed','succeeded')),message TEXT NOT NULL,
        receipt JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE UNIQUE INDEX IF NOT EXISTS retired_rag_one_purge ON retired_rag_purges(retirement_id) WHERE state IN ('queued','running');
        CREATE OR REPLACE FUNCTION neurocenter_project_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            PERFORM pg_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||NEW.id,0));
            IF EXISTS(SELECT 1 FROM project_retirements WHERE project_id=NEW.id) THEN
                RAISE EXCEPTION 'Retired project identity cannot be reused' USING ERRCODE='23514';
            END IF; RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS neurocenter_project_retirement_guard ON projects;
        CREATE TRIGGER neurocenter_project_retirement_guard BEFORE INSERT OR UPDATE OF id ON projects
            FOR EACH ROW EXECUTE FUNCTION neurocenter_project_retirement_guard()
`;
