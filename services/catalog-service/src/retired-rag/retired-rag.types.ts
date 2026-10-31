export interface IRetirement {
    id: string;
    project_id: string;
    project_name: string;
    deleted_at: string;
    retain_until: string | null;
    retention_revision: number;
    retention_reason: string;
    origin: string;
}
export interface IRetiredFacts {
    identity: { cluster: string; oid: string; marker: string; databaseName: string; projectId: string };
    retirementId: string;
    bytes: number;
    chunks: number;
    generations: number;
    backupPolicy: 'retained-until-explicit-purge';
    preserves: Array<'backups' | 'lance-snapshots' | 'local-files'>;
}
export interface IPurgeRow {
    id: string;
    retirement_id: string;
    preview_id: string;
    digest: string;
    actor: string;
    state: 'queued' | 'running' | 'failed' | 'succeeded';
    message: string;
    receipt: unknown;
    created_at: string;
    updated_at: string;
}
export interface IPreviewRow {
    id: string;
    retirement_id: string;
    digest: string;
    facts: IRetiredFacts;
    retention_revision: number;
    expires_at: string;
}
export const publicPurge = (row: IPurgeRow) => ({
    id: row.id,
    retirementId: row.retirement_id,
    state: row.state,
    message: row.message,
    receipt: row.receipt,
    digest: row.digest,
    updatedAt: row.updated_at,
});
