import { SYSTEM_ROLE_SCHEMA_CONTRACT } from './system-role.schema-contract';

/** Schema33 changes only these two constraints; the remaining immutable role contracts stay exact. */
export const CURRENT_SYSTEM_ROLE_SCHEMA_CONTRACT = SYSTEM_ROLE_SCHEMA_CONTRACT.map((fact) => {
    const constraints: Record<string, string> = {
        'system_role_runs.system_role_runs_agent_id_check':
            "CHECK (agent_id = ANY (ARRAY['agent-ai-admin'::text, 'agent-autoconfigurator'::text, 'agent-indexer'::text, 'agent-packager'::text, 'agent-coordinator'::text]))",
        'system_role_runs.system_role_runs_calls_started_check':
            "CHECK (calls_started >= 0 AND calls_started <=\nCASE\n    WHEN agent_id = 'agent-coordinator'::text THEN 5\n    ELSE 2\nEND)",
    };
    return constraints[fact.id]
        ? { ...fact, definition: { type: 'c', validated: true, definition: constraints[fact.id] } }
        : fact;
});
