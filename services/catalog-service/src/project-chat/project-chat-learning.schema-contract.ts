import { PROJECT_CHAT_DIALOGS_SCHEMA_CONTRACT } from './project-chat-dialogs.schema-contract';

/** Migration31 physical facts measured on the owned PostgreSQL16.14 QA instance. */
export const PROJECT_CHAT_LEARNING_SCHEMA_CONTRACT = [
    { kind: 'column', id: 'project_chat_messages.learning', definition: { type: 'jsonb', default: null, notNull: false } },
    { kind: 'constraint', id: 'project_chat_messages.project_chat_message_learning_check', definition: { type: 'c', validated: true,
        definition: "CHECK (learning IS NULL OR COALESCE(kind = 'agent'::text AND status = 'done'::text AND jsonb_typeof(learning) = 'object'::text AND octet_length(learning::text) <= 262144 AND (learning ->> 'projectId'::text) = project_id AND (learning ->> 'agentId'::text) = (snapshot ->> 'agentId'::text) AND ((learning ->> 'status'::text) = ANY (ARRAY['applied'::text, 'empty'::text, 'disabled'::text])) AND jsonb_typeof(learning -> 'entries'::text) = 'array'::text, false))" } },
    { kind: 'function', id: 'neurocenter_project_chat_message_immutable()', definition: { definitionMd5: 'ff2e4e71218b5843fb1af1cffebea79d' } },
];

export const CURRENT_PROJECT_CHAT_LEARNING_SCHEMA_CONTRACT = [
    ...PROJECT_CHAT_DIALOGS_SCHEMA_CONTRACT.filter(fact => fact.kind !== 'function' || fact.id !== 'neurocenter_project_chat_message_immutable()'),
    ...PROJECT_CHAT_LEARNING_SCHEMA_CONTRACT,
];
