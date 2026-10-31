/** Migration43 physical facts measured on an owned PostgreSQL16.15. */
export const SERVICE_ROLE_CONVERSATIONS_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'system_role_dialogs.agent_id',
        definition: {
            type: 'text',
            default: null,
            notNull: false,
        },
    },
    {
        kind: 'constraint',
        id: 'system_role_dialogs.system_role_dialogs_agent_id_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (agent_id = ANY (ARRAY['agent-coordinator'::text, 'agent-ai-admin'::text, 'agent-autoconfigurator'::text, 'agent-indexer'::text, 'agent-packager'::text]))",
        },
    },
    {
        kind: 'index',
        id: 'system_role_dialog_role_history',
        definition: {
            ready: true,
            valid: true,
            definition:
                'CREATE INDEX system_role_dialog_role_history ON system_role_dialogs USING btree (owner_email, project_id, agent_id, updated_at DESC, id DESC)',
        },
    },
    {
        kind: 'function',
        id: 'service_role_conversation_intent_guard()',
        definition: {
            definitionMd5: '2df2a8676ae3859f77269fe418814d74',
        },
    },
    {
        kind: 'function',
        id: 'service_role_conversation_pin_guard()',
        definition: {
            definitionMd5: 'cda03e75b3aa5f0c2ba5a4f0e9a62c57',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_dialogs.service_role_conversation_pin_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER service_role_conversation_pin_guard BEFORE UPDATE OF agent_id ON system_role_dialogs FOR EACH ROW EXECUTE FUNCTION service_role_conversation_pin_guard()',
        },
    },
    {
        kind: 'trigger',
        id: 'system_role_dialog_intents.service_role_conversation_intent_guard',
        definition: {
            enabled: 'O',
            definition:
                'CREATE TRIGGER service_role_conversation_intent_guard BEFORE INSERT ON system_role_dialog_intents FOR EACH ROW EXECUTE FUNCTION service_role_conversation_intent_guard()',
        },
    },
];
