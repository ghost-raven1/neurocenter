/**
 * FR-306: per-agent tool profile (AP02). Applied by a dedicated migration because the frozen
 * migration 7 checksum in catalog_schema_migrations must stay byte-identical for existing deployments.
 * Approved pins mirror the project's exact approved kit (FR-202, project_assets); experiments are
 * device-local capability tests, audited and never part of the approved kit.
 */
export const AGENT_EXTENSION_SCHEMA_SQL = `
CREATE TABLE agent_extension_pins (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,agent_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,asset_kind TEXT NOT NULL CHECK(asset_kind IN ('mcp','plugin','skill')),
    asset_version INTEGER NOT NULL,asset_manifest TEXT NOT NULL CHECK(asset_manifest ~ '^[a-f0-9]{64}$'),
    pin_snapshot JSONB NOT NULL,added_by TEXT NOT NULL,added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,agent_id,asset_id,asset_kind));
CREATE TABLE agent_extension_experiments (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,agent_id TEXT NOT NULL,
    device_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_kind TEXT NOT NULL CHECK(asset_kind IN ('mcp','plugin','skill')),
    declared_version INTEGER NOT NULL,declared_manifest TEXT NOT NULL CHECK(declared_manifest ~ '^[a-f0-9]{64}$'),
    purpose TEXT NOT NULL DEFAULT 'capability-test',expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ,
    added_by TEXT NOT NULL,added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(project_id,agent_id,asset_id,asset_kind));
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON agent_extension_pins FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON agent_extension_experiments FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
`;
/** Frozen migration 7: native agent cards, immutable templates and project desired state. */
/**
 * FR-307: operator-free self-onboarding. The record captures the agent's auto-configured role,
 * approved-knowledge context (FR-502), catalog tool profile (FR-306/agt-08 kit) and public-chat
 * access at assign time. Applied by a dedicated migration because the frozen historical migration
 * checksums must stay byte-identical for existing deployments (same pattern as AGENT_EXTENSION_SCHEMA_SQL).
 * onboarded_at is the C2 t0 anchor; the first useful operation t1 is derived at read time from the
 * first completed project-chat response (model_chat_agent_responses), never written by this table.
 */
export const AGENT_ONBOARDING_SCHEMA_SQL = `
CREATE TABLE agent_onboarding (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,agent_id TEXT NOT NULL,
    agent_version INTEGER NOT NULL CHECK(agent_version>0),agent_manifest TEXT NOT NULL CHECK(agent_manifest ~ '^[a-f0-9]{64}$'),
    role TEXT NOT NULL CHECK(role IN ('primary','subagent','all')),role_source TEXT NOT NULL DEFAULT 'pinned-card' CHECK(role_source IN ('pinned-card')),
    context_status TEXT NOT NULL CHECK(context_status IN ('approved','empty','blocked')),
    context_digest TEXT CHECK(context_digest IS NULL OR context_digest ~ '^[a-f0-9]{64}$'),
    context_revision INTEGER CHECK(context_revision IS NULL OR context_revision>=0),context_entries INTEGER NOT NULL DEFAULT 0 CHECK(context_entries>=0),
    tools_count INTEGER NOT NULL DEFAULT 0 CHECK(tools_count>=0),tools JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(tools)='array'),
    public_chat_enabled BOOLEAN NOT NULL DEFAULT true,public_chat_status TEXT NOT NULL CHECK(public_chat_status IN ('active','disabled')),
    onboarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),added_by TEXT NOT NULL,
    PRIMARY KEY(project_id,agent_id));
CREATE INDEX agent_onboarding_project ON agent_onboarding(project_id,onboarded_at DESC);
CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON agent_onboarding FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard();
`;
/** Frozen migration 7: native agent cards, immutable templates and project desired state. */
export const AGENT_SCHEMA_SQL = `
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
