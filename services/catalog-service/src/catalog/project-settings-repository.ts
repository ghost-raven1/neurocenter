import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { securityEvent } from '../access/security-events';
import type { IQuota, TProjectState } from './dto';
import type { IProjectRow } from './project-row';
import { validateProjectSettings } from './project-validation';

export interface IProjectSettingsPatch {
    state?: TProjectState;
    retention?: number;
    quotas?: IQuota;
    fsRootPath?: string;
}

function settings(row: IProjectRow) {
    return { projectId: row.id, state: row.state, retention: row.retention, quotas: row.quota, fsRootPath: row.fs_root_path };
}

/** Настройки и аудит сохраняются вместе; блокировка строки сериализует одинаковые повторы. */
export class ProjectSettingsRepository {
    constructor(private readonly pool: Pool) {}

    async update(idOrName: string, body: IProjectSettingsPatch, actor: string): Promise<IProjectRow | null> {
        validateProjectSettings(body);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query<IProjectRow>(
                `SELECT projects.*,(SELECT count(*)::int FROM operations o
                    WHERE (o.project_id=projects.id OR (o.project_id=projects.name AND projects.name NOT LIKE 'prj-%'))
                    AND o.state IN ('QUEUED','RUNNING')) AS active_operations
                 FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%')
                 ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE OF projects`, [idOrName]);
            const before = result.rows[0];
            if (!before) { await client.query('COMMIT'); return null; }
            const after = { ...before };
            if (body.state !== undefined) after.state = body.state;
            if (body.retention !== undefined) after.retention = body.retention;
            if (body.fsRootPath !== undefined) after.fs_root_path = body.fsRootPath;
            if (body.quotas && Object.keys(body.quotas).length) {
                const quota = typeof before.quota === 'string' ? JSON.parse(before.quota) : before.quota;
                after.quota = { ...quota, ...body.quotas };
            }
            if (!isDeepStrictEqual(settings(before), settings(after))) {
                await client.query('UPDATE projects SET state=$2,retention=$3,quota=$4::jsonb,fs_root_path=$5,updated_at=now() WHERE id=$1',
                    [before.id, after.state, after.retention, after.quota === null ? null : JSON.stringify(after.quota), after.fs_root_path]);
                await securityEvent(client, { actor, action: 'project.settings.update', resourceId: before.id,
                    before: settings(before), after: settings(after) });
            }
            await client.query('COMMIT');
            return after;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
}
