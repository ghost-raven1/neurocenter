import type { Pool } from 'pg';

/** Старый каталог не получает неявных одобрений при обновлении схемы. */
export async function setupInstallPlans(pool: Pool): Promise<void> {
    await pool.query(`CREATE TABLE IF NOT EXISTS device_install_plans (
        id uuid PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        asset_kind text NOT NULL, asset_id text NOT NULL, version integer NOT NULL CHECK(version>0),
        manifest text NOT NULL CHECK(manifest ~ '^[a-f0-9]{64}$'), package jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','revoked')),
        revision integer NOT NULL DEFAULT 0, created_by text NOT NULL,
        approved_by text, approved_at timestamptz, revoked_by text, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(project_id,asset_kind,asset_id,version,manifest));
        ALTER TABLE device_install_plans ADD COLUMN IF NOT EXISTS installation_set jsonb;
        CREATE INDEX IF NOT EXISTS device_install_plans_project ON device_install_plans(project_id,created_at);`);
}
