/** Frozen migration 7: native agent cards, immutable templates and project desired state. */
export const AGENT_SCHEMA_SQL=`
CREATE TABLE agent_catalog (
    id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,definition JSONB NOT NULL CHECK(jsonb_typeof(definition)='object'),
    version INTEGER NOT NULL CHECK(version>0),manifest TEXT NOT NULL CHECK(manifest ~ '^[a-f0-9]{64}$'),archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE agent_catalog_versions (
    agent_id TEXT NOT NULL REFERENCES agent_catalog(id),version INTEGER NOT NULL CHECK(version>0),slug TEXT NOT NULL,name TEXT NOT NULL,
    definition JSONB NOT NULL CHECK(jsonb_typeof(definition)='object'),manifest TEXT NOT NULL CHECK(manifest ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(agent_id,version),UNIQUE(agent_id,version,manifest));
CREATE TABLE project_agent_sets (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE project_agents (
    project_id TEXT NOT NULL REFERENCES project_agent_sets(project_id) ON DELETE CASCADE,agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,manifest TEXT NOT NULL,overrides JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(overrides)='object'),
    enabled BOOLEAN NOT NULL DEFAULT false,removed BOOLEAN NOT NULL DEFAULT false,
    added_by TEXT NOT NULL,added_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,agent_id),FOREIGN KEY(agent_id,version,manifest) REFERENCES agent_catalog_versions(agent_id,version,manifest),
    CHECK(NOT removed OR NOT enabled));
CREATE TABLE agent_mutation_requests (
    actor TEXT NOT NULL,request_key UUID NOT NULL,request_hash TEXT NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(actor,request_key));
CREATE FUNCTION neurocenter_agent_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Agent versions are immutable'; END $$;
CREATE TRIGGER neurocenter_agent_version_immutable BEFORE UPDATE OR DELETE ON agent_catalog_versions FOR EACH ROW EXECUTE FUNCTION neurocenter_agent_version_immutable();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON project_agent_sets FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON project_agents FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
`;
