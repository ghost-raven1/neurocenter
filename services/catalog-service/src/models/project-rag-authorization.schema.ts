/** Migration30 preserves old intents explicitly as receipt-only; no author is inferred from project history. */
export const PROJECT_RAG_AUTHORIZATION_SCHEMA_SQL = `
ALTER TABLE project_rag_sync_intents ADD COLUMN author_email TEXT;
ALTER TABLE project_rag_sync_intents ADD COLUMN author_role TEXT;
ALTER TABLE project_rag_sync_intents ADD COLUMN write_policy TEXT NOT NULL DEFAULT 'legacy-receipt-only-v1';
ALTER TABLE project_rag_sync_intents ADD CONSTRAINT project_rag_sync_intents_author_policy_check CHECK (
 (write_policy='legacy-receipt-only-v1' AND author_email IS NULL AND author_role IS NULL)
 OR (write_policy='fresh-project-writer-v1' AND author_email IS NOT NULL AND author_role IS NOT NULL
     AND author_email=lower(author_email) AND length(author_email) BETWEEN 3 AND 254
     AND author_role IN ('Главный админ','Админ проекта','Разработчик')));
`;
