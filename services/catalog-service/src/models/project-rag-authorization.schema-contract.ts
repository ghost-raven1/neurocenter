/** Frozen migration30 physical facts measured on the owned PostgreSQL QA fixture. */
export const PROJECT_RAG_AUTHORIZATION_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'project_rag_sync_intents.author_email',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_rag_sync_intents.author_role',
        definition: { type: 'text', default: null, notNull: false },
    },
    {
        kind: 'column',
        id: 'project_rag_sync_intents.write_policy',
        definition: { type: 'text', default: "'legacy-receipt-only-v1'::text", notNull: true },
    },
    {
        kind: 'constraint',
        id: 'project_rag_sync_intents.project_rag_sync_intents_author_policy_check',
        definition: {
            type: 'c',
            validated: true,
            definition:
                "CHECK (write_policy = 'legacy-receipt-only-v1'::text AND author_email IS NULL AND author_role IS NULL OR write_policy = 'fresh-project-writer-v1'::text AND author_email IS NOT NULL AND author_role IS NOT NULL AND author_email = lower(author_email) AND length(author_email) >= 3 AND length(author_email) <= 254 AND (author_role = ANY (ARRAY['Главный админ'::text, 'Админ проекта'::text, 'Разработчик'::text])))",
        },
    },
];
