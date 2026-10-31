import type { PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import type { SnapshotService } from './snapshot.service';
import type { SnapshotBlob } from './snapshot-storage';

/** Explicit deletions are collected in bounded batches; durable object intents survive lost ACK/crash. */
export class SnapshotGarbageCollector {
    constructor(private readonly snapshots: SnapshotService) {}
    async collect(): Promise<{ processed: number; deleted: number }> {
        if (await this.snapshots.storage().recoverWrite()) return { processed: 1, deleted: 0 };
        const client = await this.snapshots.pool.connect();
        let processed = 0,
            deleted = 0;
        try {
            const locked = (
                await client.query(
                    "SELECT pg_try_advisory_lock(hashtextextended('neurocenter:snapshot-storage',0)) AS locked",
                )
            ).rows[0].locked;
            if (!locked) return { processed, deleted };
            const candidate = (
                await client.query(`SELECT s.id,s.project_id FROM project_snapshots s JOIN projects p ON p.id=s.project_id
                WHERE s.status='DELETING' AND s.delete_after<=now() AND p.head_snapshot_id IS DISTINCT FROM s.id::text
                AND NOT EXISTS(SELECT 1 FROM project_snapshot_profiles r WHERE r.snapshot_id=s.id) ORDER BY s.delete_after LIMIT 1`)
            ).rows[0];
            if (!candidate) return { processed, deleted };
            await client.query('BEGIN');
            const project = (
                await client.query('SELECT head_snapshot_id FROM projects WHERE id=$1 FOR UPDATE', [
                    candidate.project_id,
                ])
            ).rows[0];
            const row = (
                await client.query(
                    "SELECT id FROM project_snapshots WHERE id=$1 AND status='DELETING' AND delete_after<=now() FOR UPDATE",
                    [candidate.id],
                )
            ).rows[0];
            if (
                !project ||
                !row ||
                project.head_snapshot_id === row.id ||
                (await client.query('SELECT 1 FROM project_snapshot_profiles WHERE snapshot_id=$1', [row.id])).rowCount
            ) {
                await client.query('ROLLBACK');
                return { processed, deleted };
            }
            const refs = (
                await client.query<{ sha256: string }>(
                    'SELECT sha256 FROM project_snapshot_blob_refs WHERE snapshot_id=$1 ORDER BY sha256 LIMIT 1',
                    [row.id],
                )
            ).rows;
            const removing: Array<{ sha256: string; blob: SnapshotBlob }> = [];
            for (const ref of refs) {
                const intent = (
                    await client.query<SnapshotBlob>(
                        "SELECT bytes,storage_id,version_id,state FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2 AND state='DELETING'",
                        [candidate.project_id, ref.sha256],
                    )
                ).rows[0];
                if (intent) {
                    removing.push({ sha256: ref.sha256, blob: intent });
                    continue;
                }
                const shared = (
                    await client.query(
                        'SELECT 1 FROM project_snapshot_blob_refs WHERE project_id=$1 AND sha256=$2 AND snapshot_id<>$3 LIMIT 1',
                        [candidate.project_id, ref.sha256, row.id],
                    )
                ).rowCount;
                if (shared) {
                    await client.query('DELETE FROM project_snapshot_blob_refs WHERE snapshot_id=$1 AND sha256=$2', [
                        row.id,
                        ref.sha256,
                    ]);
                    processed++;
                    continue;
                }
                const blob = (
                    await client.query<SnapshotBlob>(
                        "UPDATE project_snapshot_blobs SET state='DELETING' WHERE project_id=$1 AND sha256=$2 RETURNING bytes,storage_id,version_id,state",
                        [candidate.project_id, ref.sha256],
                    )
                ).rows[0];
                if (blob) removing.push({ sha256: ref.sha256, blob });
                else {
                    await client.query('DELETE FROM project_snapshot_blob_refs WHERE snapshot_id=$1 AND sha256=$2', [
                        row.id,
                        ref.sha256,
                    ]);
                    processed++;
                }
            }
            await client.query('COMMIT'); // Never undo this intent after touching the object store.
            for (const item of removing) {
                await this.snapshots.storage().remove(candidate.project_id, item.sha256, item.blob);
                await client.query('BEGIN');
                await client.query(
                    "DELETE FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2 AND state='DELETING' AND storage_id=$3 AND version_id IS NOT DISTINCT FROM $4",
                    [candidate.project_id, item.sha256, item.blob.storage_id, item.blob.version_id],
                );
                await client.query('DELETE FROM project_snapshot_blob_refs WHERE snapshot_id=$1 AND sha256=$2', [
                    candidate.id,
                    item.sha256,
                ]);
                await client.query('COMMIT');
                processed++;
            }
            deleted = await this.finish(client, candidate.id, candidate.project_id);
            return { processed, deleted };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            await client
                .query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:snapshot-storage',0))")
                .catch(() => undefined);
            client.release();
        }
    }
    private async finish(client: PoolClient, id: string, projectId: string): Promise<number> {
        await client.query('BEGIN');
        const project = (
            await client.query('SELECT head_snapshot_id FROM projects WHERE id=$1 FOR UPDATE', [projectId])
        ).rows[0];
        if (
            !project ||
            project.head_snapshot_id === id ||
            (await client.query('SELECT 1 FROM project_snapshot_profiles WHERE snapshot_id=$1', [id])).rowCount
        ) {
            await client.query('ROLLBACK');
            return 0;
        }
        const result = await client.query(
            "UPDATE project_snapshots SET status='DELETED' WHERE id=$1 AND status='DELETING' AND NOT EXISTS(SELECT 1 FROM project_snapshot_blob_refs WHERE snapshot_id=$1) RETURNING id",
            [id],
        );
        if (result.rowCount)
            await securityEvent(client, {
                actor: 'snapshot-gc',
                action: 'snapshot.deleted',
                resourceId: id,
                before: { status: 'DELETING' },
                after: { status: 'DELETED', projectId },
            });
        await client.query('COMMIT');
        return result.rowCount ?? 0;
    }
}
