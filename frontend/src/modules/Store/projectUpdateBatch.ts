import type { IStoreApp } from '../../features/Catalog/interfaces';
import type { IProjectAsset } from '../../core/api/interfaces';
import type { IBridgeJob } from '../../features/McpBridge/api';
import { isPending } from '../../features/McpBridge/installationHelpers';

export interface IUpdateBatchProject {
    id: string;
    name: string;
    /** Управление каталогом проекта (роль ≥ 3) — только такие проекты участвуют в батче. */
    canManage: boolean;
}

export interface IUpdateBatchRow {
    key: string;
    projectId: string;
    projectName: string;
    assetId: string;
    assetKind: string;
    name: string;
    from: number;
    to: number;
    /** CAS-ожидание из закреплённой строки проекта; сервер подтверждает именно их. */
    expectedVersion: number | null;
    expectedManifest: string | null;
    head: IStoreApp;
    ref: IProjectAsset;
}

export interface IUpdateBatchOptions {
    projects: readonly IUpdateBatchProject[];
    /** Каталоги проектов: projectId → закреплённые назначения. */
    byProject: Readonly<Record<string, readonly IProjectAsset[]>>;
    common: readonly IStoreApp[];
    /** Общий каталог прочитан и актуален. */
    catalogReady: boolean;
}

/**
 * Строки вкладки «Обновления проектов»: назначение проекта закреплено за точной редакцией,
 * а общий каталог предлагает более новую. Логика строки — та же, что у «Применить обновление»
 * карточки, только без привязки к выбранному проекту: строка существует сама по себе.
 */
export function projectUpdateBatchRows(options: IUpdateBatchOptions): IUpdateBatchRow[] {
    const rows: IUpdateBatchRow[] = [];
    if (!options.catalogReady) return rows;
    for (const project of options.projects) {
        if (!project.canManage) continue;
        for (const ref of options.byProject[project.id] ?? []) {
            if (ref.pinError || ref.version == null) continue;
            const head = options.common.find((item) => item.id === ref.assetId && item.kind === ref.assetKind);
            if (!head || head.version <= ref.version) continue;
            rows.push({
                key: `${project.id}:${ref.assetKind}:${ref.assetId}`,
                projectId: project.id,
                projectName: project.name,
                assetId: ref.assetId,
                assetKind: ref.assetKind,
                name: head.name,
                from: ref.version,
                to: head.version,
                expectedVersion: ref.version,
                expectedManifest: ref.manifest ?? null,
                head,
                ref,
            });
        }
    }
    return rows;
}

export type TUpdateInstallStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * Живой статус установки предложенной редакции в проекте. Задания моста глобальны для всех
 * проектов (job.projectId), поэтому статус читается без чтения каталога проекта. Терминальное
 * состояние показывается только для заданий, которые ставили именно предложенную редакцию:
 * успех старой редакции не означает, что обновление уже установлено.
 */
export function projectUpdateInstallStatus(
    jobs: readonly IBridgeJob[],
    target: { projectId: string; assetId: string; assetKind: string; version: number },
): TUpdateInstallStatus {
    const matching = jobs.filter(
        (job) =>
            job.kind === 'install' &&
            job.projectId === target.projectId &&
            job.assetId === target.assetId &&
            job.assetKind === target.assetKind,
    );
    if (matching.length === 0) return 'idle';
    const byNewest = (a: IBridgeJob, b: IBridgeJob): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    const latest = [...matching].sort(byNewest)[0];
    if (isPending(latest)) return latest.state === 'queued' ? 'queued' : 'running';
    const forVersion = matching
        .filter((job) => job.version != null && Number(job.version) === target.version)
        .sort(byNewest)[0];
    if (!forVersion) return 'idle';
    if (isPending(forVersion)) return forVersion.state === 'queued' ? 'queued' : 'running';
    return forVersion.state === 'succeeded' ? 'succeeded' : 'failed';
}

export interface IUpdatePinOutcome {
    key: string;
    state: 'ok' | 'conflict' | 'error';
    message?: string;
}

/** Итог массового закрепления: строка без исхода считается не тронутой. */
export function summarizePinOutcomes(
    rows: readonly IUpdateBatchRow[],
    outcomes: ReadonlyMap<string, IUpdatePinOutcome>,
): { total: number; ok: number; conflict: number; error: number } {
    let ok = 0;
    let conflict = 0;
    let error = 0;
    for (const row of rows) {
        const outcome = outcomes.get(row.key);
        if (outcome?.state === 'ok') ok += 1;
        else if (outcome?.state === 'conflict') conflict += 1;
        else if (outcome?.state === 'error') error += 1;
    }
    return { total: rows.length, ok, conflict, error };
}
