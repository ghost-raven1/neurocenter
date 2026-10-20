import type { PoolClient } from 'pg';

/** Приватное подключение отделено от публичного descriptor и его source envelope. */
export async function setupRemoteConnections(db: PoolClient): Promise<void> {
    await db.query(`CREATE TABLE IF NOT EXISTS model_remote_connections (
        model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
        revision BIGINT NOT NULL CHECK(revision>0), base_url TEXT NOT NULL, request_dimensions BOOLEAN NOT NULL,
        credential_kind TEXT NOT NULL CHECK(credential_kind IN ('none','stored','environment')),
        credential JSONB, credential_env TEXT, semantic_sha TEXT, verified_at TIMESTAMPTZ,
        failure_message TEXT, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(model_id,revision), CHECK(semantic_sha IS NULL OR semantic_sha ~ '^[a-f0-9]{64}$'),
        CHECK((credential_kind='stored' AND credential IS NOT NULL AND credential_env IS NULL)
            OR (credential_kind='environment' AND credential IS NULL AND credential_env IS NOT NULL)
            OR (credential_kind='none' AND credential IS NULL AND credential_env IS NULL))
    ); CREATE INDEX IF NOT EXISTS model_remote_semantic ON model_remote_connections(model_id,semantic_sha,revision DESC)`);
}
