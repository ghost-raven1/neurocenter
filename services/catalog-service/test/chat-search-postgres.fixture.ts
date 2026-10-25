import {deviceCompletionFixture} from './device-completion-postgres.fixture';
import {PROJECT_CHAT_SCHEMA_SQL} from '../src/project-chat/project-chat.schema';
import {PROJECT_CHAT_DIALOGS_SCHEMA_SQL} from '../src/project-chat/project-chat-dialogs.schema';
/** Only an explicitly owned non-default loopback PostgreSQL database receives fixtures. */
export async function chatSearchFixture(url:string){
    const f=await deviceCompletionFixture(url);
    await f.pool.query(`CREATE TABLE projects(id text PRIMARY KEY,name text NOT NULL,state text NOT NULL DEFAULT 'ACTIVE');
      CREATE TABLE platform_users(email text PRIMARY KEY,enabled boolean NOT NULL DEFAULT true,is_main_admin boolean NOT NULL DEFAULT false,display_name text NOT NULL DEFAULT 'Fixture');
      CREATE TABLE project_members(project_id text REFERENCES projects(id) ON DELETE CASCADE,principal_name text,display_name text,role text,PRIMARY KEY(project_id,principal_name));
      CREATE TABLE model_usage_calls(id uuid PRIMARY KEY);CREATE TABLE project_models(project_id text,model_id text);`);
    await f.pool.query(PROJECT_CHAT_SCHEMA_SQL);await f.pool.query(PROJECT_CHAT_DIALOGS_SCHEMA_SQL);return f;
}
