/** Migration54 physical facts measured on owned PostgreSQL16. */
export const PROJECT_DELETION_RECEIPT_SCHEMA_CONTRACT = [
    {
        kind: 'column',
        id: 'project_retirements.deleted_resources',
        definition: {
            type: 'jsonb',
            default: "'{}'::jsonb",
            notNull: true,
        },
    },
];
