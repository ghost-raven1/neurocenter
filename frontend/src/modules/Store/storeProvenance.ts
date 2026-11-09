import type { IBundlePackage, IAiPluginVersion } from '../../core/api/interfaces';

/**
 * Поля провенанса активной версии (FR-203): версия + SHA + источник + время + издатель.
 * SHA — только server-issued (manifest.sha256 self-verified пакета); клиент не пересчитывает.
 */
export interface IProvenance {
    version: number;
    /** manifest.sha256 delivery-пакета версии (server-issued). */
    sha256: string;
    /** Source envelope из метаданных версии (origin). */
    origin: string | null;
    /** Source envelope из метаданных версии (revision). */
    revision: string | null;
    createdAt: string;
    author: string;
    /** Статус версии (entry 7): показывается, если поле уже присутствует в данных. */
    status?: 'active' | 'retired';
}

/** Источник-заполнитель: карточка head, если у старой версии нет envelope в метаданных. */
export interface IProvenanceFallback {
    origin?: string;
    revision?: string | null;
}

/**
 * Собирает провенанс-карточку из данных `/versions` и `/package`.
 *
 * @param version - строка истории версий (активная версия).
 * @param pkg - self-verified пакет той же версии.
 * @param fallback - карточка head для старых версий без envelope.
 * @param expectedVersion - опц., сверка: данные относятся к выбранной версии.
 * @returns {IProvenance}
 */
export function buildProvenance(
    version: IAiPluginVersion,
    pkg: IBundlePackage,
    fallback: IProvenanceFallback = {},
    expectedVersion?: number,
): IProvenance {
    if (
        expectedVersion !== undefined &&
        (version.version !== expectedVersion || pkg.plugin.version !== expectedVersion)
    ) {
        throw new Error('Данные провенанса не относятся к выбранной версии.');
    }
    if (pkg.plugin.id.length === 0 || typeof pkg.manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pkg.manifest.sha256)) {
        throw new Error('SHA пакета не подтверждён сервером.');
    }
    const origin = version.metadata?.origin ?? fallback.origin ?? null;
    const revision = version.metadata?.revision ?? fallback.revision ?? null;
    const status: unknown = (version.metadata as Record<string, unknown> | undefined)?.status;
    return {
        version: version.version,
        sha256: pkg.manifest.sha256,
        origin,
        revision,
        createdAt: version.createdAt,
        author: version.author,
        ...(status === 'active' || status === 'retired' ? { status: status as 'active' | 'retired' } : {}),
    };
}
