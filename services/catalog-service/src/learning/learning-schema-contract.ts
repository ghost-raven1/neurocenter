/** Frozen structural facts introduced by project learning. */
export const LEARNING_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'project_learning_candidates.approved_at',
        definition: { type: 'timestamp with time zone', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.approved_by',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.check_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.created_by',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.data',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.hypothesis_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.key',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.reason',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.status',
        definition: { type: 'text', default: "'proposed'::text", notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_candidates.version',
        definition: { type: 'integer', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_checks.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_checks.created_by',
        definition: { type: 'text', default: null, notNull: true },
    },
    { kind: 'column', id: 'project_learning_checks.data', definition: { type: 'jsonb', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'project_learning_checks.hypothesis_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    { kind: 'column', id: 'project_learning_checks.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'project_learning_checks.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_checks.revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_experiences.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_experiences.created_by',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_experiences.data',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_experiences.id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_experiences.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_heads.candidate_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    { kind: 'column', id: 'project_learning_heads.key', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'project_learning_heads.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_history.action',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_history.actor',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_history.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_history.details',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    { kind: 'column', id: 'project_learning_history.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'project_learning_history.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_history.resource_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_history.revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.created_by',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.data',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.model',
        definition: { type: 'jsonb', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.revision',
        definition: { type: 'bigint', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_hypotheses.status',
        definition: { type: 'text', default: "'open'::text", notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_requests.actor',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_requests.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_requests.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_requests.request_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_requests.request_key',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_requests.result',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_state.project_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_state.revision',
        definition: { type: 'bigint', default: '0', notNull: true },
    },
    {
        kind: 'column',
        id: 'project_learning_state.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_check',
        definition: { type: 'c', validated: true, definition: 'CHECK ((approved_by IS NULL) = (approved_at IS NULL))' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_check1',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK ((status <> ALL (ARRAY['approved'::text, 'revoked'::text])) OR approved_at IS NOT NULL)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_data_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(data) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_key_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text AND length(key) <= 64)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_project_id_check_id_hypothesis_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, check_id, hypothesis_id) REFERENCES project_learning_checks(project_id, id, hypothesis_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_project_id_hypothesis_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, hypothesis_id) REFERENCES project_learning_hypotheses(project_id, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_project_id_key_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (project_id, key, id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_project_id_key_version_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (project_id, key, version)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = ANY (ARRAY['proposed'::text, 'approved'::text, 'rejected'::text, 'revoked'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_candidates.project_learning_candidates_version_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (version > 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_checks.project_learning_checks_data_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(data) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_checks.project_learning_checks_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_checks.project_learning_checks_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_checks.project_learning_checks_project_id_hypothesis_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, hypothesis_id) REFERENCES project_learning_hypotheses(project_id, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_checks.project_learning_checks_project_id_id_hypothesis_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (project_id, id, hypothesis_id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_checks.project_learning_checks_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_experiences.project_learning_experiences_data_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(data) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_experiences.project_learning_experiences_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_experiences.project_learning_experiences_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_experiences.project_learning_experiences_project_id_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (project_id, id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_heads.project_learning_heads_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (project_id, key)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_heads.project_learning_heads_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_heads.project_learning_heads_project_id_key_candidate_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (project_id, key, candidate_id) REFERENCES project_learning_candidates(project_id, key, id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_history.project_learning_history_details_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(details) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_history.project_learning_history_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_history.project_learning_history_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_history.project_learning_history_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_hypotheses.project_learning_hypotheses_data_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(data) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_hypotheses.project_learning_hypotheses_model_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (model IS NULL OR jsonb_typeof(model) = 'object'::text)",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_hypotheses.project_learning_hypotheses_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_hypotheses.project_learning_hypotheses_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_hypotheses.project_learning_hypotheses_project_id_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (project_id, id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_hypotheses.project_learning_hypotheses_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision > 0)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_hypotheses.project_learning_hypotheses_status_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (status = ANY (ARRAY['open'::text, 'supported'::text, 'refuted'::text, 'inconclusive'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_requests.project_learning_requests_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (actor, request_key)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_requests.project_learning_requests_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES project_learning_state(project_id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_requests.project_learning_requests_request_hash_check',
        definition: { type: 'c', validated: true, definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_requests.project_learning_requests_result_check',
        definition: { type: 'c', validated: true, definition: "CHECK (jsonb_typeof(result) = 'object'::text)" },
    },
    {
        kind: 'constraint',
        id: 'project_learning_state.project_learning_state_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (project_id)' },
    },
    {
        kind: 'constraint',
        id: 'project_learning_state.project_learning_state_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'project_learning_state.project_learning_state_revision_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (revision >= 0)' },
    },
    {
        kind: 'function',
        id: 'neurocenter_learning_immutable()',
        definition: { definitionMd5: '1d4dc46f57ec4e48986a8bfa52574cfc' },
    },
    {
        kind: 'index',
        id: 'project_learning_candidates_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_candidates_pkey ON project_learning_candidates USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_candidates_project',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_learning_candidates_project ON project_learning_candidates USING btree (project_id, created_at DESC, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_candidates_project_id_key_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_candidates_project_id_key_id_key ON project_learning_candidates USING btree (project_id, key, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_candidates_project_id_key_version_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_candidates_project_id_key_version_key ON project_learning_candidates USING btree (project_id, key, version)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_checks_hypothesis',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_learning_checks_hypothesis ON project_learning_checks USING btree (project_id, hypothesis_id, created_at, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_checks_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX project_learning_checks_pkey ON project_learning_checks USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_checks_project_id_id_hypothesis_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_checks_project_id_id_hypothesis_id_key ON project_learning_checks USING btree (project_id, id, hypothesis_id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_experiences_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_experiences_pkey ON project_learning_experiences USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_experiences_project',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_learning_experiences_project ON project_learning_experiences USING btree (project_id, created_at DESC, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_experiences_project_id_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_experiences_project_id_id_key ON project_learning_experiences USING btree (project_id, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_heads_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_heads_pkey ON project_learning_heads USING btree (project_id, key)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_history_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_history_pkey ON project_learning_history USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_history_project',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_learning_history_project ON project_learning_history USING btree (project_id, revision DESC, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_hypotheses_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_hypotheses_pkey ON project_learning_hypotheses USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_hypotheses_project',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX project_learning_hypotheses_project ON project_learning_hypotheses USING btree (project_id, created_at DESC, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_hypotheses_project_id_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_hypotheses_project_id_id_key ON project_learning_hypotheses USING btree (project_id, id)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_requests_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_requests_pkey ON project_learning_requests USING btree (actor, request_key)',
        },
    },
    {
        kind: 'index',
        id: 'project_learning_state_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX project_learning_state_pkey ON project_learning_state USING btree (project_id)',
        },
    },
    { kind: 'table', id: 'project_learning_candidates', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_learning_checks', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_learning_experiences', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_learning_heads', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_learning_history', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_learning_hypotheses', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_learning_requests', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'project_learning_state', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'project_learning_candidates.neurocenter_learning_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_learning_immutable BEFORE DELETE OR UPDATE ON project_learning_candidates FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_learning_checks.neurocenter_learning_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_learning_immutable BEFORE DELETE OR UPDATE ON project_learning_checks FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_learning_experiences.neurocenter_learning_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_learning_immutable BEFORE DELETE OR UPDATE ON project_learning_experiences FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_learning_history.neurocenter_learning_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_learning_immutable BEFORE DELETE OR UPDATE ON project_learning_history FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_learning_hypotheses.neurocenter_learning_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_learning_immutable BEFORE DELETE OR UPDATE ON project_learning_hypotheses FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_learning_requests.neurocenter_learning_immutable',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_learning_immutable BEFORE DELETE OR UPDATE ON project_learning_requests FOR EACH ROW EXECUTE FUNCTION neurocenter_learning_immutable()',
        },
    },
    {
        kind: 'trigger',
        id: 'project_learning_state.neurocenter_retired_reference_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON project_learning_state FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()',
        },
    },
] as const;
