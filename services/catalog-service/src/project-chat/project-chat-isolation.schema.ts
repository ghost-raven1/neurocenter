/** Migration32 relaxes project-wide exclusion to room FIFO without changing existing messages or attribution. */
export const PROJECT_CHAT_ISOLATION_SCHEMA_SQL = `
DROP INDEX project_chat_single_running;
CREATE UNIQUE INDEX project_chat_single_running ON project_chat_messages(project_id,room_id) WHERE kind='user' AND status='running';
`;
