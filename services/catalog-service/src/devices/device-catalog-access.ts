import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { assertProjectCatalogAsset, isProjectSkill } from './project-skill';
import { checkedProjectPackage, projectAssetColumns, type IProjectPinRow } from '../catalog/project-asset-pins';

type Queryable = Pick<PoolClient, 'query'>;
/** Root назначения проверяется по exact package SHA; leaf разрешены immutable графом root. */
export async function assertDeviceCatalogAsset(
    db: Queryable,
    projectId: unknown,
    kind: unknown,
    id: unknown,
    expected?: { version: number; manifest: string },
    lock = false,
): Promise<void> {
    assertProjectCatalogAsset(kind, id, projectId);
    if (isProjectSkill(kind, id, projectId)) return;
    const row = (
        await db.query<IProjectPinRow>(
            `SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 AND asset_kind=$2 AND asset_id=$3${lock ? ' FOR SHARE' : ''}`,
            [projectId, kind, id],
        )
    ).rows[0];
    if (!row) throw new ForbiddenException('Админ проекта должен добавить этот инструмент в каталог проекта.');
    if (expected) {
        const pkg = checkedProjectPackage(row);
        if (pkg.plugin.version !== expected.version || pkg.manifest.sha256 !== expected.manifest)
            throw new ConflictException(
                'В проекте закреплена другая версия или SHA. Откройте новый план для актуального назначения.',
            );
    }
}

/** Выдаёт immutable bytes назначения; архивирование head не требует связи с файловым сервисом. */
export async function projectAssignedPackage(
    db: Queryable,
    projectId: string,
    kind: string,
    id: string,
    version: number,
) {
    if (isProjectSkill(kind, id, projectId)) return null;
    const row = (
        await db.query<IProjectPinRow>(
            `SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 AND asset_kind=$2 AND asset_id=$3`,
            [projectId, kind, id],
        )
    ).rows[0];
    if (!row) throw new ForbiddenException('Добавьте инструмент в каталог проекта.');
    const pkg = checkedProjectPackage(row);
    if (pkg.plugin.version !== version)
        throw new ConflictException('В проекте закреплена другая версия. Обновите каталог проекта.');
    return pkg;
}
