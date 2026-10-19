import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { securityEvent } from '../access/security-events';

interface IAssetRow {
    project_id: string;
    asset_id: string;
    asset_kind: string;
    added_by: string;
    added_at: string | Date;
}

const columns = 'project_id,asset_id,asset_kind,added_by,added_at';

function summary(row: IAssetRow) {
    return { projectId: row.project_id, assetId: row.asset_id, assetKind: row.asset_kind, addedBy: row.added_by,
        addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at };
}

/** Состав каталога и его аудит фиксируются вместе; повтор не создаёт ложного изменения. */
export class ProjectAssetRepository {
    constructor(private readonly pool: Pool) {}

    private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }

    private async audit(client: PoolClient, actor: string, action: 'add' | 'remove', row: IAssetRow): Promise<void> {
        await securityEvent(client, { actor, action: `project.asset.${action}`,
            resourceId: `${row.project_id} · ${row.asset_kind} · ${row.asset_id}`,
            before: action === 'remove' ? summary(row) : null, after: action === 'add' ? summary(row) : null });
    }

    add(projectId: string, assetId: string, assetKind: string, actor: string): Promise<void> {
        return this.transaction(async client => {
            if (assetKind !== 'skill') {
                // Совместно с delete FOR UPDATE не позволяет назначить уже удалённую карточку.
                const plugin = await client.query<{ kind: string }>('SELECT kind FROM ai_plugins WHERE id=$1 FOR KEY SHARE', [assetId]);
                if (!plugin.rows[0]) { throw new NotFoundException('Инструмент уже удалён из общего каталога. Обновите список.'); }
                if (plugin.rows[0].kind !== assetKind) { throw new BadRequestException('Тип инструмента не соответствует карточке общего каталога.'); }
            }
            const result = await client.query<IAssetRow>(
                `INSERT INTO project_assets (project_id,asset_id,asset_kind,added_by) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (project_id,asset_id,asset_kind) DO NOTHING RETURNING ${columns}`, [projectId, assetId, assetKind, actor]);
            if (result.rows[0]) { await this.audit(client, actor, 'add', result.rows[0]); }
        });
    }

    remove(projectId: string, assetId: string, assetKind: string, actor: string): Promise<boolean> {
        return this.transaction(async client => {
            const result = await client.query<IAssetRow>(
                `DELETE FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3 RETURNING ${columns}`,
                [projectId, assetId, assetKind]);
            if (!result.rows[0]) { return false; }
            await this.audit(client, actor, 'remove', result.rows[0]);
            return true;
        });
    }
}
