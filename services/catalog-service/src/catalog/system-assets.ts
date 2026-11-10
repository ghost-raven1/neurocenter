import type { Pool, PoolClient } from 'pg';
import { readBundledCatalog } from '../../../shared/bundled-catalog.cjs';

/**
 * Системные (обязательные) ассеты (Epic 12, story 12.1).
 *
 * Каталог приложения несёт явный REQUIRED-набор: карточки с маркерами
 * `system: true` + `required: true` и подсистемой. Эти ассеты — базовое
 * состояние Нейроцентра: устройство без них «не готово», а проект при
 * создании получает их автоматически и не может их удалить.
 *
 * Источник истины — манифест app-bundled-каталога (immutable, SHA-верифицирован),
 * поэтому набор кэшируется на время жизни процесса.
 */

/** Исполнитель автоматического назначения — не человек, а каталог. */
export const SYSTEM_ASSET_ACTOR = 'system:catalog';

/** Подсистемы, разрешённые контрактом (дублируем для читателёв без вендора). */
export const SYSTEM_SUBSYSTEMS = ['core', 'rag', 'system-roles', 'agent-team'] as const;
export type TSystemSubsystem = (typeof SYSTEM_SUBSYSTEMS)[number];

export interface ISystemAsset {
    /** id ассета в app-bundled-каталоге (external_id). */
    id: string;
    kind: string;
    name: string;
    subsystem: TSystemSubsystem;
    note?: string;
    delivery?: string;
}

let cachedRequired: ISystemAsset[] | null = null;

function fromManifest(row: Record<string, unknown>): ISystemAsset {
    const delivery = row.delivery as { type?: string } | undefined;
    return {
        id: row.id as string,
        kind: row.kind as string,
        name: row.name as string,
        subsystem: row.subsystem as TSystemSubsystem,
        note: typeof row.note === 'string' ? row.note : undefined,
        delivery: delivery?.type,
    };
}

/** REQUIRED-набор из манифеста app-bundled-каталога (кэш на процесс). */
export async function requiredSystemAssets(): Promise<ISystemAsset[]> {
    if (!cachedRequired) {
        const bundle = await readBundledCatalog();
        // Общий .d.cts не описывает `current` (внутренний раздел манифеста) — уточняем тип локально.
        const manifest = bundle.manifest as unknown as { current?: Array<Record<string, unknown>> };
        cachedRequired = (manifest.current ?? [])
            .filter((row) => row.system === true && row.required === true)
            .map(fromManifest);
    }
    return cachedRequired;
}

/**
 * Проектный REQUIRED-набор: REQUIRED-набор минус bridge.
 *
 * Bridge — device-level компонент (сам канал устройства); его готовность —
 * это подключённость устройства, а не запись в проект. Остальные 11 ассетов
 * назначаются проекту и контролируются system-readiness.
 */
export async function projectSystemAssets(): Promise<ISystemAsset[]> {
    return (await requiredSystemAssets()).filter((asset) => asset.kind !== 'bridge');
}

export async function findSystemAsset(id: string): Promise<ISystemAsset | null> {
    const found = (await requiredSystemAssets()).find((asset) => asset.id === id);
    return found ?? null;
}

type TQueryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * Разрешает native-идентификатор для bundled-ассета по активной квитанции
 * импорта из app-bundled (external_id → native_id). null — ещё не импортирован.
 */
export async function resolveNativeId(db: TQueryable, bundledId: string): Promise<string | null> {
    const res = await db.query<{ native_id: string }>(
        'SELECT native_id FROM asset_source_receipts WHERE repository=\'app-bundled\' AND external_id=$1 AND active',
        [bundledId],
    );
    return res.rows[0]?.native_id ?? null;
}

/**
 * Обратное разрешение: нативный id + kind → REQUIRED-описание, если это
 * системный обязательный ассет. Используется для запрета удаления.
 */
export async function requiredAssetForNative(
    db: TQueryable,
    nativeId: string,
    kind: string,
): Promise<ISystemAsset | null> {
    const res = await db.query<{ external_id: string }>(
        'SELECT external_id FROM asset_source_receipts WHERE repository=\'app-bundled\' AND native_id=$1 AND asset_kind=$2 AND active',
        [nativeId, kind],
    );
    const externalId = res.rows[0]?.external_id;
    if (!externalId) return null;
    return findSystemAsset(externalId);
}

/** Основание для явной ошибки запрета удаления системного ассета. */
export function systemAssetRemovalMessage(asset: ISystemAsset): string {
    const basis = asset.note ? ` Основание: ${asset.note}` : '';
    return `Системный обязательный ассет «${asset.name}» (${asset.kind}, подсистема «${asset.subsystem}») нельзя удалить из проекта.${basis}`;
}
