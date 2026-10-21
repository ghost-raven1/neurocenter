/** Frozen baseline schema; only the catalog migration runner executes this SQL. */
export const PUBLICATION_SCHEMA_SQL=`
ALTER TABLE ai_plugins ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
            ALTER TABLE ai_plugins ADD COLUMN IF NOT EXISTS publication_key TEXT;
            ALTER TABLE ai_plugins ADD COLUMN IF NOT EXISTS publication_hash TEXT;
            CREATE UNIQUE INDEX IF NOT EXISTS ai_plugins_publication_key ON ai_plugins (publication_key);
            ALTER TABLE ai_plugin_versions ADD COLUMN IF NOT EXISTS metadata JSONB;
            ALTER TABLE ai_plugins ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '[]'::jsonb;;
CREATE TABLE IF NOT EXISTS skill_dependency_reservations (
        key TEXT NOT NULL, skill_path TEXT NOT NULL, dependencies JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(key,skill_path)
    );
CREATE TABLE IF NOT EXISTS skill_audit_receipts (
            event_id UUID PRIMARY KEY, payload JSONB NOT NULL
        );
ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS asset_version INTEGER;
        ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS asset_manifest TEXT;
        ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS pin_origin TEXT NOT NULL DEFAULT 'unresolved';
        ALTER TABLE project_assets ADD COLUMN IF NOT EXISTS pin_snapshot JSONB;
        DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='project_assets'::regclass AND conname='project_asset_pin_shape') THEN
            ALTER TABLE project_assets ADD CONSTRAINT project_asset_pin_shape CHECK (
                (asset_version IS NULL AND asset_manifest IS NULL AND pin_snapshot IS NULL AND pin_origin='unresolved') OR
                (asset_version>0 AND asset_manifest ~ '^[a-f0-9]{64}$' AND pin_snapshot IS NOT NULL AND pin_origin IN ('assigned','manual','migration-current'))) NOT VALID;
        END IF; END $$;
`;
