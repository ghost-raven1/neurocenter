/** Exact schema28 facts measured from a caller-owned PostgreSQL16.15 cluster; SQL history stays immutable. */
export const SYSTEM_ROLE_SCHEMA_CONTRACT: ReadonlyArray<{ kind: string; id: string; definition: unknown }> = [
    {
        kind: 'column',
        id: 'project_snapshot_verifiers.container_observation',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.actor',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.actor_role',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.agent_id',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.applied',
        definition: {
            type: 'jsonb',
            default: "'[]'::jsonb",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.calls_started',
        definition: {
            type: 'integer',
            default: '0',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.created_at',
        definition: {
            type: 'timestamp with time zone',
            default: 'now()',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.facts',
        definition: {
            type: 'jsonb',
            default: "'[]'::jsonb",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.finished_at',
        definition: {
            type: 'timestamp with time zone',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.lease_token',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.lease_until',
        definition: {
            type: 'timestamp with time zone',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.message',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.model',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.phase',
        definition: {
            type: 'text',
            default: "'queued'::text",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.project_id',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.request',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.request_hash',
        definition: {
            type: 'text',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.request_id',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.result',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.revision',
        definition: {
            type: 'integer',
            default: '0',
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.runner_instance',
        definition: {
            type: 'uuid',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.snapshot',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.state',
        definition: {
            type: 'text',
            default: "'queued'::text",
            notNull: true,
        },
    },
    {
        kind: 'column',
        id: 'system_role_runs.steps',
        definition: {
            type: 'jsonb',
            default: null,
            notNull: true,
        },
    },
    {
        kind: 'constraint',
        id: 'project_snapshot_verifiers.project_snapshot_verifiers_container_observation_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (container_observation IS NULL OR jsonb_typeof(container_observation) = 'object'::text AND octet_length(container_observation::text) <= 16384)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_actor_request_id_key',
        definition: {
            type: 'u',
            validated: true,
            definition: 'UNIQUE (actor, request_id)',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_agent_id_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (agent_id = ANY (ARRAY['agent-ai-admin'::text, 'agent-autoconfigurator'::text, 'agent-indexer'::text, 'agent-packager'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_applied_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(applied) = 'array'::text AND jsonb_array_length(applied) <= 4 AND octet_length(applied::text) <= 8192)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_calls_started_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (calls_started >= 0 AND calls_started <= 2)',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'applying'::text])) AND lease_until IS NOT NULL AND finished_at IS NULL OR state = 'awaiting_review'::text AND lease_until IS NULL AND finished_at IS NULL OR (state = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text])) AND lease_until IS NULL AND finished_at IS NOT NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_facts_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(facts) = 'array'::text AND jsonb_array_length(facts) <= 4 AND octet_length(facts::text) <= 65536)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_message_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (octet_length(message) <= 2048)',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_model_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(model) = 'object'::text AND octet_length(model::text) <= 16384)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_phase_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (phase ~ '^[a-z_]{1,64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_pkey',
        definition: {
            type: 'p',
            validated: true,
            definition: 'PRIMARY KEY (id)',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_request_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(request) = 'object'::text AND octet_length(request::text) <= 131072)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_request_hash_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_result_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (result IS NULL OR jsonb_typeof(result) = 'object'::text AND octet_length(result::text) <= 32768)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_revision_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (revision >= 0)',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_snapshot_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(snapshot) = 'object'::text AND octet_length(snapshot::text) <= 524288)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_state_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (state = ANY (ARRAY['queued'::text, 'running'::text, 'awaiting_review'::text, 'applying'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_runs.system_role_runs_steps_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(steps) = 'array'::text AND jsonb_array_length(steps) <= 32 AND octet_length(steps::text) <= 16384)",
        },
    },
    {
        kind: 'function',
        id: 'system_role_run_guard()',
        definition: {
            definitionMd5: '373d0838f2300186db28ab5306181e15',
        },
    },
    {
        kind: 'index',
        id: 'system_role_owner_history',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX system_role_owner_history ON system_role_runs USING btree (actor, agent_id, project_id, created_at DESC, id)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_pending_runner',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE INDEX system_role_pending_runner ON system_role_runs USING btree (runner_instance, created_at, id) WHERE (state = 'queued'::text)",
        },
    },
    {
        kind: 'index',
        id: 'system_role_runs_actor_request_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX system_role_runs_actor_request_id_key ON system_role_runs USING btree (actor, request_id)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_runs_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX system_role_runs_pkey ON system_role_runs USING btree (id)',
        },
    },
    {
        kind: 'table',
        id: 'system_role_runs',
        definition: {
            kind: 'r',
            persistence: 'p',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_runs.neurocenter_retired_reference_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON system_role_runs FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_runs.system_role_run_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER system_role_run_guard BEFORE UPDATE ON system_role_runs FOR EACH ROW EXECUTE FUNCTION system_role_run_guard()',
        },
    },
];
