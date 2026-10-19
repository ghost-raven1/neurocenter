import { ForbiddenException } from '@nestjs/common';
import type { Pool } from 'pg';
import { assertProjectCatalogAsset, isProjectSkill } from './project-skill';

/** Проектный каталог разрешает выбор инструмента; одобрение его кода проверяется отдельно. */
export async function assertDeviceCatalogAsset(pool: Pool, projectId: unknown, kind: unknown, id: unknown): Promise<void> {
    assertProjectCatalogAsset(kind, id, projectId);
    if (isProjectSkill(kind, id, projectId)) { return; }
    const result = await pool.query('SELECT 1 FROM project_assets WHERE project_id=$1 AND asset_kind=$2 AND asset_id=$3', [projectId, kind, id]);
    if (!result.rowCount) { throw new ForbiddenException('Админ проекта должен добавить этот инструмент в каталог проекта.'); }
}
