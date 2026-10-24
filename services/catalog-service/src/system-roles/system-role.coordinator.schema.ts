/** Migration33 adds one builtin and raises only its journal budget; historical migrations remain unchanged. */
export const SYSTEM_ROLE_COORDINATOR_SCHEMA_SQL = `
ALTER TABLE system_role_runs DROP CONSTRAINT system_role_runs_agent_id_check;
ALTER TABLE system_role_runs ADD CONSTRAINT system_role_runs_agent_id_check CHECK(agent_id IN ('agent-ai-admin','agent-autoconfigurator','agent-indexer','agent-packager','agent-coordinator'));
ALTER TABLE system_role_runs DROP CONSTRAINT system_role_runs_calls_started_check;
ALTER TABLE system_role_runs ADD CONSTRAINT system_role_runs_calls_started_check CHECK(calls_started>=0 AND calls_started<=CASE WHEN agent_id='agent-coordinator' THEN 5 ELSE 2 END);
`;
