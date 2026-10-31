import { CURRENT_PROJECT_CHAT_LEARNING_SCHEMA_CONTRACT } from './project-chat-learning.schema-contract';

/** Migration32 index facts measured on the owned PostgreSQL16.14 QA instance. */
export const PROJECT_CHAT_ISOLATION_SCHEMA_CONTRACT = [
    {
        kind: 'index',
        id: 'project_chat_single_running',
        definition: {
            ready: true,
            valid: true,
            definition:
                "CREATE UNIQUE INDEX project_chat_single_running ON project_chat_messages USING btree (project_id, room_id) WHERE ((kind = 'user'::text) AND (status = 'running'::text))",
        },
    },
];
export const CURRENT_PROJECT_CHAT_ISOLATION_SCHEMA_CONTRACT = [
    ...CURRENT_PROJECT_CHAT_LEARNING_SCHEMA_CONTRACT.filter(
        (fact) => fact.kind !== 'index' || fact.id !== 'project_chat_single_running',
    ),
    ...PROJECT_CHAT_ISOLATION_SCHEMA_CONTRACT,
];
