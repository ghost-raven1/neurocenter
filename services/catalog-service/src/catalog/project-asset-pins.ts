import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { buildPackage, type IPackage } from './bundle-package';
import type { IAiPlugin, IProjectAsset } from './dto';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';
import { isContractVersion } from '../../../shared/runtime/contract-version.cjs';
import { assertInstallablePackage } from '../devices/installation-set';
import { toPlugin } from '../publication/plugin-repository';
import { readSkillPackage } from '../publication/skill-package';
import { SkillAssetClient } from '../asset-sources/skill-adapter';

type TQueryable = Pick<PoolClient, 'query'>;
export interface IProjectAssetSnapshot {
    card: Record<string, unknown>;
    package: IPackage;
}
export interface IProjectPinRow {
    project_id: string;
    asset_id: string;
    asset_kind: string;
    added_by: string;
    added_at: string | Date;
    asset_version: number | null;
    asset_manifest: string | null;
    pin_origin: string;
    pin_snapshot: IProjectAssetSnapshot | null;
}
export const projectAssetColumns =
    'project_id,asset_id,asset_kind,added_by,added_at,asset_version,asset_manifest,pin_origin,pin_snapshot';

export function projectAssetView(row: IProjectPinRow): IProjectAsset {
    return {
        assetId: row.asset_id,
        assetKind: row.asset_kind as IProjectAsset['assetKind'],
        addedBy: row.added_by,
        addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at,
        version: row.asset_version,
        manifest: row.asset_manifest,
        pinOrigin: row.pin_origin as IProjectAsset['pinOrigin'],
    };
}

/** Нативный publication builder совпадает с delivery-контрактом, включая exact dependency pins. */
export function pluginDeliveryPackage(plugin: IAiPlugin): IPackage {
    const dependencies = normalizeDependencyPins(plugin.dependencies);
    const config = dependencies.length
        ? { ...plugin.config, extra: { ...plugin.config?.extra, requirements: { mcp: [], plugins: [], dependencies } } }
        : plugin.config;
    return buildPackage(
        { id: plugin.id, name: plugin.name, kind: plugin.kind, version: plugin.version },
        plugin.files.map((file) => ({ path: file.path, content: file.content ?? '' })),
        new Date().toISOString(),
        config,
    );
}

/** Вызывается под management lock; старый head и immutable history читаются в одной SQL-транзакции. */
export async function captureProjectAsset(
    db: TQueryable,
    id: string,
    kind: string,
    version?: number,
): Promise<IProjectAssetSnapshot> {
    if (kind === 'skill') {
        const info = await new SkillAssetClient().inspect(id);
        if (info.archivedAt) throw new ConflictException('Скилл в архиве и не добавляется в новые назначения.');
        const data = await readSkillPackage(id, version ?? info.version),
            pkg = data.package;
        assertInstallablePackage(pkg);
        return {
            package: pkg,
            card: { path: id, meta: data.meta, body: data.body, resources: data.resources, history: [] },
        };
    }
    const head = (await db.query('SELECT * FROM ai_plugins WHERE id=$1 FOR SHARE', [id])).rows[0];
    if (!head) throw new NotFoundException('Инструмент отсутствует в общем каталоге.');
    if (head.archived_at) throw new ConflictException('Инструмент в архиве и не добавляется в новые назначения.');
    if (head.kind !== kind) throw new ConflictException('Тип карточки не совпадает с выбранным инструментом.');
    let plugin = toPlugin(head);
    let contractVersion: unknown;
    if (version !== undefined && version !== plugin.version) {
        const old = (
            await db.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=$2', [id, version])
        ).rows[0];
        if (!old) throw new NotFoundException('Выбранная версия инструмента отсутствует в истории.');
        // AD-16: отозванная (retired) версия не назначается в новые проекты.
        if (old.status === 'retired')
            throw new ConflictException('Версия инструмента отозвана и не назначается в проекты.');
        plugin = {
            ...plugin,
            ...old.metadata,
            id,
            version,
            files: old.files,
            config: old.config,
            dependencies: normalizeDependencyPins(old.metadata?.dependencies),
        };
        if (plugin.kind !== kind) throw new ConflictException('Историческая версия имеет другой тип.');
        contractVersion = old.metadata?.contractVersion;
    } else {
        // AD-13: издательская версия контракта хранится в metadata закреплённой версии, не в колонках ai_plugins.
        const headVersion = (
            await db.query<{ metadata: { contractVersion?: unknown } | null; status: string }>(
                'SELECT metadata,status FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=$2',
                [id, plugin.version],
            )
        ).rows[0];
        // AD-16: отозванный (retired) head не назначается в новые проекты.
        if (headVersion?.status === 'retired')
            throw new ConflictException('Версия инструмента отозвана и не назначается в проекты.');
        contractVersion = headVersion?.metadata?.contractVersion;
    }
    const pkg = pluginDeliveryPackage(plugin);
    assertInstallablePackage(pkg);
    const card = plugin as unknown as Record<string, unknown>;
    // В снапшот попадает только строгий semver; handshake читает card.contractVersion (fail-open при его отсутствии).
    if (isContractVersion(contractVersion)) card.contractVersion = contractVersion;
    return { card, package: pkg };
}

/** Проверка сохранённых байтов обязательна и при чтении, и при каждом разрешении установки. */
export function checkedProjectPackage(row: IProjectPinRow): IPackage {
    if (!row.asset_version || !row.asset_manifest || !row.pin_snapshot)
        throw new ConflictException(
            'Версия назначения проекта ещё не подтверждена. Админ проекта должен закрепить конкретную версию.',
        );
    const pkg = row.pin_snapshot.package;
    assertInstallablePackage(pkg);
    if (
        pkg.plugin.id !== row.asset_id ||
        pkg.plugin.kind !== row.asset_kind ||
        pkg.plugin.version !== row.asset_version ||
        pkg.manifest.sha256 !== row.asset_manifest
    ) {
        throw new ConflictException('Снимок назначения проекта не соответствует закреплённой версии и SHA.');
    }
    return pkg;
}
