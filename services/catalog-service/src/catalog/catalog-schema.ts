/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const CATALOG_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                external_resource_id TEXT,
                fs_root_path TEXT,
                state TEXT NOT NULL DEFAULT 'ACTIVE',
                head_snapshot_id TEXT,
                head_snapshot_date TEXT,
                head_author TEXT,
                head_revision BIGINT NOT NULL DEFAULT 0,
                logical_bytes BIGINT NOT NULL DEFAULT 0,
                retained_bytes BIGINT NOT NULL DEFAULT 0,
                retention INTEGER NOT NULL DEFAULT 30,
                active_profile_id TEXT,
                active_profile_revision INTEGER NOT NULL DEFAULT 0,
                active_operations INTEGER NOT NULL DEFAULT 0,
                quota JSONB,
                rag_project_key TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
              );
               ALTER TABLE projects ADD COLUMN IF NOT EXISTS fs_root_path TEXT;;
CREATE TABLE IF NOT EXISTS ai_plugins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL DEFAULT 'mcp',
                description TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                compatibility TEXT,
                tags TEXT[] NOT NULL DEFAULT '{}',
                origin TEXT NOT NULL DEFAULT 'upload',
                revision TEXT,
                config JSONB,
                files JSONB NOT NULL DEFAULT '[]',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
              );;
CREATE TABLE IF NOT EXISTS ai_plugin_versions (
                ai_plugin_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                files JSONB NOT NULL,
                config JSONB,
                author TEXT NOT NULL DEFAULT 'admin',
                note TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (ai_plugin_id, version)
              );;
CREATE TABLE IF NOT EXISTS operations (
                operation_id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                project_id TEXT,
                resource_type TEXT NOT NULL,
                resource_id TEXT NOT NULL,
                actor TEXT NOT NULL,
                state TEXT NOT NULL,
                percent INTEGER NOT NULL DEFAULT 0,
                bytes_done BIGINT NOT NULL DEFAULT 0,
                bytes_total BIGINT NOT NULL DEFAULT 0,
                started_at TIMESTAMPTZ,
                finished_at TIMESTAMPTZ,
                error TEXT,
                log JSONB NOT NULL DEFAULT '[]'::jsonb,
                retries INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
              );
              CREATE TABLE IF NOT EXISTS backup_state (
                key TEXT NOT NULL PRIMARY KEY,
                value TIMESTAMPTZ
              );
              CREATE TABLE IF NOT EXISTS project_members (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                principal_name TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL,
                added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                 PRIMARY KEY (project_id, user_id)
               );
               CREATE TABLE IF NOT EXISTS project_assets (
                 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                 asset_id TEXT NOT NULL,
                 asset_kind TEXT NOT NULL,
                 added_by TEXT NOT NULL DEFAULT 'admin',
                 added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                 PRIMARY KEY (project_id, asset_id, asset_kind)
               );
`;
