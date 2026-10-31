import { ConflictException } from '@nestjs/common';
import { toBridgeRelease, type BridgeAsset } from '@neurocenter/asset-contract';
import { publicationHash } from '../publication/publication-validation';
import type { Pool } from 'pg';
import type { IBridgeSourceSettings } from './bridge-source.repository';
import { validBridgeVersion } from './bridge-source-version';

/** Download hosts may change in a fork; version-only Gateway URLs still require identical payloads and runtime metadata. */
export function bridgeSupplyIdentity(asset: BridgeAsset): string {
    const release = toBridgeRelease(asset);
    return publicationHash({
        version: release.version,
        buildId: release.buildId,
        artifacts: release.artifacts
            .map(({ file, metadata }) => ({ file, metadata }))
            .sort((a, b) => a.file.localeCompare(b.file)),
    });
}
/** Stable semantic versions never move the site head backwards, including when its source repository changes. */
export async function assertBridgeHead(db: Pick<Pool, 'query'>, asset: BridgeAsset): Promise<void> {
    const settings = (await db.query<IBridgeSourceSettings>('SELECT * FROM bridge_source_settings WHERE singleton'))
        .rows[0];
    const rows = settings?.installed_repository
        ? (
              await db.query<{ descriptor: BridgeAsset }>(
                  "SELECT descriptor FROM asset_source_receipts WHERE asset_kind='bridge' AND repository=$1 AND external_id=$2 AND active",
                  [settings.installed_repository, settings.installed_asset_id],
              )
          ).rows
        : (
              await db.query<{ descriptor: BridgeAsset }>(
                  "SELECT descriptor FROM asset_source_receipts WHERE asset_kind='bridge' AND active ORDER BY updated_at DESC",
              )
          ).rows;
    if (settings?.installed_repository && !rows.length)
        throw new ConflictException(
            'Текущая поставка моста недоступна. Восстановите её перед подготовкой новой версии.',
        );
    if (rows.length > 1)
        throw new ConflictException('Текущая поставка моста неоднозначна. Требуется выбор главного администратора.');
    const candidate = toBridgeRelease(asset);
    if (!validBridgeVersion(candidate.version))
        throw new ConflictException(
            'Нужна стабильная версия моста вида 1.2.3, без ведущих нулей и слишком больших чисел.',
        );
    const history = (
        await db.query<{ descriptor: BridgeAsset }>(
            "SELECT descriptor FROM asset_source_versions WHERE asset_kind='bridge' AND descriptor->'delivery'->'release'->>'version'=$1",
            [candidate.version],
        )
    ).rows;
    if (history.some((row) => bridgeSupplyIdentity(row.descriptor) !== bridgeSupplyIdentity(asset)))
        throw new ConflictException('Источник заменил содержимое уже опубликованной версии моста. Нужна новая версия.');
    if (!rows.length) return;
    const current = toBridgeRelease(rows[0].descriptor);
    if (!validBridgeVersion(current.version))
        throw new ConflictException(
            'Нужна стабильная версия моста вида 1.2.3, без ведущих нулей и слишком больших чисел.',
        );
    const left = candidate.version.split('.').map(BigInt),
        right = current.version.split('.').map(BigInt);
    const difference = left.findIndex((value, index) => value !== right[index]);
    if (difference >= 0 && left[difference] < right[difference])
        throw new ConflictException('Понижение версии моста запрещено. Текущая поставка сохранена.');
    if (difference < 0 && bridgeSupplyIdentity(asset) !== bridgeSupplyIdentity(rows[0].descriptor))
        throw new ConflictException('Источник заменил сборку уже опубликованной версии моста. Нужна новая версия.');
}
