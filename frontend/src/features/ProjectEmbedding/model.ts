import api from '../../core/api/base';
import type { IRagIndexProfile } from '../../core/api/interfaces';
import type { ICatalogModel } from '../ModelCatalog/interfaces';

export interface IProjectEmbedding {
    projectId: string;
    revision: number;
    expectedDimension: number;
    model: ICatalogModel | null;
    modelPin: string | null;
    profile: IRagIndexProfile | null;
    blocker?: string;
    activeGeneration: string;
    activeSnapshot: string | null;
    dataRevision: number;
    target?: IProjectEmbeddingTarget | null;
}
/** Стабильная идентичность установки OpenCodeRAG; binding/instance не персистируются. */
export interface IProjectEmbeddingTargetInstallation {
    deviceId: string;
    assetId: string;
    assetKind: 'mcp' | 'plugin';
    version: number;
    expectedManifest: string;
}
/** Персист «Куда подключить модель», общий для команды. */
export interface IProjectEmbeddingTarget {
    mode: 'server' | 'computer';
    installation: IProjectEmbeddingTargetInstallation | null;
}
/** Ключ совпадает с embeddingInstallationKey: kind, id, версия и проверенный снимок. */
export const targetInstallationKey = (installation: IProjectEmbeddingTargetInstallation): string =>
    JSON.stringify([installation.assetKind, installation.assetId, installation.version, installation.expectedManifest]);
export const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const eligibleEmbedding = (model: ICatalogModel, dimension?: number): boolean =>
    model.capability === 'embedding' &&
    Number.isSafeInteger(model.dimension) &&
    Number(model.dimension) > 0 &&
    Number(model.dimension) <= 16000 &&
    (dimension === undefined || model.dimension === dimension) &&
    (model.runtime === 'ollama'
        ? sha(model.manifestSha256)
        : ['remote-openai', 'remote-ollama'].includes(model.runtime) &&
          !!model.modelVersion &&
          sha(model.verificationSha256));

/** Только подтверждённый текущий pin и полный серверный снимок означают готовое подключение. */
export function selectedEmbeddingMatches(
    selection: IProjectEmbedding | undefined,
    model: ICatalogModel,
): selection is IProjectEmbedding {
    return (
        !!selection &&
        !selection.blocker &&
        sha(selection.activeSnapshot) &&
        sha(model.modelPin) &&
        selection.model?.id === model.id &&
        selection.modelPin === model.modelPin &&
        selection.revision > 0 &&
        selection.expectedDimension === model.dimension &&
        selection.profile?.dimension === model.dimension &&
        selection.profile?.provider === 'openai' &&
        selection.profile.model === `neurocenter/${model.id}/sha256/${model.modelPin}`
    );
}

const incompleteTarget = (): never => {
    throw new Error('Сервер вернул неполный выбор подключения. Обновите сведения.');
};
/** Неполный персист не становится управляющим состоянием всех трёх селекторов. */
export function requireProjectEmbeddingTarget(value: unknown): IProjectEmbeddingTarget | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) incompleteTarget();
    const target = value as { mode?: unknown; installation?: unknown };
    if (target.mode === 'server') {
        if (target.installation !== undefined && target.installation !== null) incompleteTarget();
        return { mode: 'server', installation: null };
    }
    if (target.mode !== 'computer') incompleteTarget();
    const item = target.installation as Record<string, unknown> | undefined;
    if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        typeof item.deviceId !== 'string' ||
        !item.deviceId ||
        typeof item.assetId !== 'string' ||
        !item.assetId ||
        (item.assetKind !== 'mcp' && item.assetKind !== 'plugin') ||
        !Number.isSafeInteger(item.version) ||
        Number(item.version) < 1 ||
        !sha(item.expectedManifest)
    )
        incompleteTarget();
    return { mode: 'computer', installation: item as unknown as IProjectEmbeddingTargetInstallation };
}
/** Неполный ответ не подменяет подтверждённый выбор пустой моделью. */
export function requireProjectEmbedding(value: IProjectEmbedding, projectId: string): IProjectEmbedding {
    if (
        !value ||
        value.projectId !== projectId ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !Number.isSafeInteger(value.expectedDimension) ||
        value.expectedDimension < 0 ||
        typeof value.activeGeneration !== 'string' ||
        !/^(?:initial-[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.test(value.activeGeneration) ||
        !(value.activeSnapshot === null || sha(value.activeSnapshot)) ||
        !Number.isSafeInteger(value.dataRevision) ||
        value.dataRevision < 0 ||
        !(
            value.model === null ||
            (value.model && typeof value.model.id === 'string' && typeof value.model.name === 'string')
        ) ||
        !(value.modelPin === null || sha(value.modelPin)) ||
        !(
            value.profile === null ||
            (value.profile &&
                value.profile.provider === 'openai' &&
                typeof value.profile.model === 'string' &&
                value.profile.model.length > 0 &&
                Number.isSafeInteger(value.profile.dimension) &&
                value.profile.dimension > 0)
        ) ||
        (value.blocker !== undefined && typeof value.blocker !== 'string') ||
        (!value.blocker &&
            value.model !== null &&
            (!value.profile ||
                !value.modelPin ||
                value.revision < 1 ||
                value.profile.dimension !== value.expectedDimension))
    ) {
        throw new Error('Сервер вернул неполный выбор модели. Обновите сведения.');
    }
    if (value.target !== undefined) requireProjectEmbeddingTarget(value.target);
    return value;
}
/** Повторное закрепление той же модели исправляет устаревший pin; очистка снимает удалённую модель. */
export const embeddingNeedsRepair = (value: IProjectEmbedding): boolean =>
    !!value.blocker && (value.model !== null || value.modelPin !== null);
export const projectEmbeddingApi = {
    read: (id: string): Promise<IProjectEmbedding> =>
        api
            .get<IProjectEmbedding>(`/api/projects/${encodeURIComponent(id)}/embedding`)
            .then((response) => requireProjectEmbedding(response.data, id)),
    save: (id: string, expectedRevision: number, modelId: string | null): Promise<IProjectEmbedding> =>
        api
            .patch<IProjectEmbedding>(`/api/projects/${encodeURIComponent(id)}/embedding`, {
                expectedRevision,
                modelId,
            })
            .then((response) => requireProjectEmbedding(response.data, id)),
    /** Персист «Куда подключить модель»; null сбрасывает выбор установки. */
    saveTarget: (id: string, target: IProjectEmbeddingTarget | null): Promise<IProjectEmbeddingTarget | null> =>
        api
            .patch<unknown>(`/api/projects/${encodeURIComponent(id)}/embedding/target`, target)
            .then((response) => requireProjectEmbeddingTarget(response.data)),
};
export function sameEmbeddingProfile(left: IRagIndexProfile, right: IRagIndexProfile): boolean {
    return left.provider === right.provider && left.model === right.model && left.dimension === right.dimension;
}
