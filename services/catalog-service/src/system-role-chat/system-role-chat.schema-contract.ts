/** Migration35 physical facts measured on an explicitly owned disposable PostgreSQL 16.14 (Debian 16.14-1.pgdg12+1). */
export const SYSTEM_ROLE_CHAT_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'system_role_dialog_contexts.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_contexts.dialog_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_contexts.id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_contexts.owner_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_contexts.pin',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_contexts.refs',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.agent_id',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.cancel_requested',
        definition: { type: 'boolean', default: 'false', notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.dialog_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    { kind: 'column', id: 'system_role_dialog_intents.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.input',
        definition: { type: 'jsonb', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.owner_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.request_hash',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.request_id',
        definition: { type: 'uuid', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialog_intents.run_id',
        definition: { type: 'uuid', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'system_role_dialogs.created_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    { kind: 'column', id: 'system_role_dialogs.id', definition: { type: 'uuid', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'system_role_dialogs.owner_email',
        definition: { type: 'text', default: null, notNull: true },
    },
    {
        kind: 'column',
        id: 'system_role_dialogs.project_id',
        definition: { type: 'text', default: null, notNull: false },
    },
    { kind: 'column', id: 'system_role_dialogs.title', definition: { type: 'text', default: null, notNull: true } },
    {
        kind: 'column',
        id: 'system_role_dialogs.updated_at',
        definition: { type: 'timestamp with time zone', default: 'now()', notNull: true },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_contexts.system_role_dialog_contexts_dialog_id_owner_email_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (dialog_id, owner_email) REFERENCES system_role_dialogs(id, owner_email) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_contexts.system_role_dialog_contexts_pin_check',
        definition: { type: 'c', validated: true, definition: "CHECK (pin ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_contexts.system_role_dialog_contexts_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_contexts.system_role_dialog_contexts_refs_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (jsonb_typeof(refs) = 'array'::text AND jsonb_array_length(refs) >= 1 AND jsonb_array_length(refs) <= 5 AND octet_length(refs::text) <= 2048)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_agent_id_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (agent_id = ANY (ARRAY['agent-coordinator'::text, 'agent-ai-admin'::text, 'agent-autoconfigurator'::text, 'agent-indexer'::text, 'agent-packager'::text]))",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_check',
        definition: { type: 'c', validated: true, definition: 'CHECK (id = request_id)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_dialog_id_owner_email_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition:
                'FOREIGN KEY (dialog_id, owner_email) REFERENCES system_role_dialogs(id, owner_email) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_input_check',
        definition: {
            type: 'c',
            validated: true,
            definition: "CHECK (jsonb_typeof(input) = 'object'::text AND octet_length(input::text) <= 131072)",
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_owner_email_request_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (owner_email, request_id)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_request_hash_check',
        definition: { type: 'c', validated: true, definition: "CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)" },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_run_id_fkey',
        definition: { type: 'f', validated: true, definition: 'FOREIGN KEY (run_id) REFERENCES system_role_runs(id)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_intents_run_id_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (run_id)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialog_intents.system_role_dialog_receipt_guard',
        definition: { type: 't', validated: true, definition: 'TRIGGER DEFERRABLE INITIALLY DEFERRED' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialogs.system_role_dialogs_id_owner_email_key',
        definition: { type: 'u', validated: true, definition: 'UNIQUE (id, owner_email)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialogs.system_role_dialogs_owner_email_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (owner_email) REFERENCES platform_users(email) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialogs.system_role_dialogs_pkey',
        definition: { type: 'p', validated: true, definition: 'PRIMARY KEY (id)' },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialogs.system_role_dialogs_project_id_fkey',
        definition: {
            type: 'f',
            validated: true,
            definition: 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialogs.system_role_dialogs_title_check',
        definition: {
            type: 'c',
            validated: true,
            definition: 'CHECK (length(btrim(title)) > 0 AND octet_length(title) <= 240)',
        },
    },
    {
        kind: 'function',
        id: 'system_role_dialog_context_guard()',
        definition: { definitionMd5: 'f64b862d093960418b084f0274bcde22' },
    },
    {
        kind: 'function',
        id: 'system_role_dialog_guard()',
        definition: { definitionMd5: '86cb2de380c20a34f6d230a220bb0b06' },
    },
    {
        kind: 'function',
        id: 'system_role_dialog_intent_guard()',
        definition: { definitionMd5: '802cf49c1abff09828d17eb9997e95b3' },
    },
    {
        kind: 'function',
        id: 'system_role_dialog_receipt_guard()',
        definition: { definitionMd5: '37aa98249d46ed3bac0b20d60387d9ec' },
    },
    {
        kind: 'index',
        id: 'system_role_dialog_contexts_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX system_role_dialog_contexts_pkey ON system_role_dialog_contexts USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialog_intents_owner_email_request_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX system_role_dialog_intents_owner_email_request_id_key ON system_role_dialog_intents USING btree (owner_email, request_id)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialog_intents_pkey',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX system_role_dialog_intents_pkey ON system_role_dialog_intents USING btree (id)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialog_intents_run_id_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX system_role_dialog_intents_run_id_key ON system_role_dialog_intents USING btree (run_id)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialog_owner_history',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX system_role_dialog_owner_history ON system_role_dialogs USING btree (owner_email, project_id, updated_at DESC, id DESC)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialog_turn_history',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX system_role_dialog_turn_history ON system_role_dialog_intents USING btree (dialog_id, owner_email, created_at DESC, id DESC)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialogs_id_owner_email_key',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE UNIQUE INDEX system_role_dialogs_id_owner_email_key ON system_role_dialogs USING btree (id, owner_email)',
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialogs_pkey',
        definition: {
            ready: true,
            valid: true,
            definition: 'CREATE UNIQUE INDEX system_role_dialogs_pkey ON system_role_dialogs USING btree (id)',
        },
    },
    { kind: 'table', id: 'system_role_dialog_contexts', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'system_role_dialog_intents', definition: { kind: 'r', persistence: 'p' } },
    { kind: 'table', id: 'system_role_dialogs', definition: { kind: 'r', persistence: 'p' } },
    {
        kind: 'trigger',
        id: 'system_role_dialog_contexts.system_role_dialog_context_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER system_role_dialog_context_guard BEFORE UPDATE ON system_role_dialog_contexts FOR EACH ROW EXECUTE FUNCTION system_role_dialog_context_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_dialog_intents.system_role_dialog_intent_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER system_role_dialog_intent_guard BEFORE UPDATE ON system_role_dialog_intents FOR EACH ROW EXECUTE FUNCTION system_role_dialog_intent_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_dialog_intents.system_role_dialog_receipt_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE CONSTRAINT TRIGGER system_role_dialog_receipt_guard AFTER INSERT OR UPDATE ON system_role_dialog_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION system_role_dialog_receipt_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_dialogs.neurocenter_retired_reference_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER neurocenter_retired_reference_guard BEFORE INSERT OR UPDATE OF project_id ON system_role_dialogs FOR EACH ROW EXECUTE FUNCTION neurocenter_retired_reference_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_dialogs.system_role_dialog_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER system_role_dialog_guard BEFORE UPDATE ON system_role_dialogs FOR EACH ROW EXECUTE FUNCTION system_role_dialog_guard()',
        },
    },
];
