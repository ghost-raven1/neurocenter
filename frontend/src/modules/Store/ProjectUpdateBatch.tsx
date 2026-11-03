import { isAxiosError } from 'axios';
import { Button, Modal } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage } from '../../common/utils/errorMessage';
import type { IProjectAsset } from '../../core/api/interfaces';
import type { IStoreApp } from '../../features/Catalog/interfaces';
import type { IBridgeJob } from '../../features/McpBridge/api';
import type { IMultiProjectCatalogEntry } from './hooks/useMultiProjectCatalog';
import {
    projectUpdateBatchRows,
    projectUpdateInstallStatus,
    summarizePinOutcomes,
    type IUpdateBatchRow,
    type IUpdatePinOutcome,
    type TUpdateInstallStatus,
} from './projectUpdateBatch';
import { kindLabel } from './storeHelpers';

const STATUS_LABEL: Record<TUpdateInstallStatus, string> = {
    idle: 'Не установлена',
    queued: 'В очереди',
    running: 'Устанавливается',
    succeeded: 'Установлено',
    failed: 'Сбой установки',
};

export interface IProjectUpdateBatchProps {
    projects: readonly { id: string; name: string }[];
    canManage: (projectId: string) => boolean;
    /** projectId → результат чтения каталога проекта. */
    byProject: Readonly<Record<string, IMultiProjectCatalogEntry>>;
    catalogsReady: boolean;
    /** Общий каталог: только приложения, чей источник уже прочитан. */
    common: readonly IStoreApp[];
    /** Задания моста глобальны (job.projectId) — живые статусы без чтения проектов. */
    jobs: readonly IBridgeJob[];
    jobsReady: boolean;
    captureOwner: () => () => boolean;
    pin: (
        projectId: string,
        payload: {
            assetId: string;
            assetKind: string;
            version: number;
            expectedVersion: number | null;
            expectedManifest: string | null;
        },
    ) => Promise<unknown>;
    /** После батча перечитать каталоги (проекты и общий). */
    onPinned: () => void;
    /** Перейти в каталог проекта и одобрить установку там. */
    onOpenProject: (projectId: string) => void;
    /** Текущий аккаунт/права: итоги батча прежней идентичности не выставляются. */
    scope: string;
}

/**
 * Вкладка «Обновления проектов»: где общий каталог новее закрепления,
 * живые статусы установки и массовое закрепление точных редакций.
 * Установка по-прежнему одобряется в каталоге каждого проекта.
 */
export function ProjectUpdateBatch({
    projects,
    canManage,
    byProject,
    catalogsReady,
    common,
    jobs,
    jobsReady,
    captureOwner,
    pin,
    onPinned,
    onOpenProject,
    scope,
}: IProjectUpdateBatchProps): JSX.Element {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pinning, setPinning] = useState(false);
    const [pinRowKey, setPinRowKey] = useState<string | null>(null);
    const [outcomes, setOutcomes] = useState<ReadonlyMap<string, IUpdatePinOutcome>>(new Map());
    /** Снимок последнего завершённого батча: перечитывание каталогов не стирает итог. */
    const [lastBatch, setLastBatch] = useState<{ total: number; ok: number; conflict: number; error: number } | null>(
        null,
    );
    /** Синхронная защита от повторного запуска батча в одном тике (confirmLoading не гасит клик). */
    const pinningRef = useRef(false);
    useEffect(() => {
        setOutcomes(new Map());
        setLastBatch(null);
    }, [scope]);
    const byAsset = useMemo(
        () =>
            Object.fromEntries(
                projects.map((project) => {
                    const entry = byProject[project.id];
                    return [project.id, entry?.ready ? (entry.assets as readonly IProjectAsset[]) : []];
                }),
            ),
        [projects, byProject],
    );
    const rows = useMemo(
        () =>
            projectUpdateBatchRows({
                projects: projects.map((project) => ({ ...project, canManage: canManage(project.id) })),
                byProject: byAsset,
                common,
                catalogReady: catalogsReady,
            }),
        [projects, canManage, byAsset, common, catalogsReady],
    );
    const failedProjects = useMemo(
        () =>
            projects.filter((project) => {
                const entry = byProject[project.id];
                return canManage(project.id) && !!entry && entry.error !== '';
            }),
        [projects, byProject, canManage],
    );
    const confirm = async (): Promise<void> => {
        if (pinningRef.current) return;
        pinningRef.current = true;
        const owns = captureOwner();
        setPinning(true);
        try {
            const next = new Map(outcomes);
            for (const row of rows) {
                if (!owns()) break;
                setPinRowKey(row.key);
                try {
                    await pin(row.projectId, {
                        assetId: row.ref.assetId,
                        assetKind: row.ref.assetKind,
                        version: row.to,
                        expectedVersion: row.expectedVersion,
                        expectedManifest: row.expectedManifest,
                    });
                    if (owns()) next.set(row.key, { key: row.key, state: 'ok' });
                } catch (cause) {
                    if (!owns()) break;
                    if (isAxiosError(cause) && cause.response?.status === 409) {
                        next.set(row.key, {
                            key: row.key,
                            state: 'conflict',
                            message: 'Закрепление изменили параллельно.',
                        });
                    } else {
                        next.set(row.key, {
                            key: row.key,
                            state: 'error',
                            message: errorMessage(cause, 'Не удалось закрепить редакцию.'),
                        });
                    }
                }
            }
            if (owns()) {
                setOutcomes(next);
                setLastBatch(summarizePinOutcomes(rows, next));
                onPinned();
            }
        } finally {
            pinningRef.current = false;
            setPinning(false);
            setPinRowKey(null);
            setConfirmOpen(false);
        }
    };
    if (!catalogsReady) {
        return <div className="store-updates-empty">Читаем каталоги проектов…</div>;
    }
    return (
        <div className="store-updates">
            <div className="store-updates-head">
                <div className="store-updates-title">
                    {rows.length > 0 ? (
                        <>Новее закрепления: {rows.length}. Закрепите точные редакции одним подтверждением.</>
                    ) : (
                        'Обновлений, новее закреплённых редакций, сейчас нет.'
                    )}
                </div>
                <Button
                    type="primary"
                    disabled={rows.length === 0 || pinning}
                    loading={pinning}
                    onClick={() => setConfirmOpen(true)}
                >
                    Закрепить редакции ({rows.length})
                </Button>
            </div>
            {lastBatch && (
                <div className="store-updates-summary">
                    Закреплено: {lastBatch.ok} из {lastBatch.total}
                    {lastBatch.conflict > 0 && ` · ${lastBatch.conflict} — закрепление изменили параллельно`}
                    {lastBatch.error > 0 && ` · ${lastBatch.error} — ошибка`}
                </div>
            )}
            {rows.length === 0 ? (
                <div className="store-updates-empty">
                    Все закреплённые редакции актуальны.
                    {failedProjects.length > 0 &&
                        ` Каталог не прочитан: ${failedProjects.map((project) => project.name).join(', ')}.`}
                </div>
            ) : (
                <div className="store-updates-list" role="list">
                    {rows.map((row) => (
                        <UpdateBatchRow
                            key={row.key}
                            row={row}
                            status={
                                jobsReady
                                    ? projectUpdateInstallStatus(jobs, {
                                          projectId: row.projectId,
                                          assetId: row.assetId,
                                          assetKind: row.assetKind,
                                          version: row.to,
                                      })
                                    : undefined
                            }
                            outcome={outcomes.get(row.key)}
                            busy={pinRowKey === row.key}
                            pinning={pinning}
                            onOpen={() => onOpenProject(row.projectId)}
                        />
                    ))}
                </div>
            )}
            {rows.length > 0 && (
                <div className="store-updates-note">
                    Установка новой редакции по-прежнему одобряется в каталоге проекта: откройте проект и подтвердите
                    план.
                </div>
            )}
            <Modal
                title="Закрепить редакции"
                open={confirmOpen}
                onCancel={() => {
                    if (!pinning) setConfirmOpen(false);
                }}
                onOk={() => {
                    void confirm();
                }}
                okText={`Закрепить (${rows.length})`}
                cancelText="Отмена"
                confirmLoading={pinning}
                maskClosable={!pinning}
            >
                <div className="store-updates-confirm">
                    <p>
                        Эти точные редакции будут закреплены в каждом проекте. Установка выполняется отдельно — вы
                        подтвердите её в каталоге проекта.
                    </p>
                    <table className="store-updates-confirm-table">
                        <thead>
                            <tr>
                                <th>Проект</th>
                                <th>Инструмент</th>
                                <th>Текущая</th>
                                <th>Новая</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.key}>
                                    <td>{row.projectName}</td>
                                    <td>
                                        {row.name} · {kindLabel(row.assetKind as 'mcp' | 'plugin' | 'skill')}
                                    </td>
                                    <td>{row.from}</td>
                                    <td>{row.to}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Modal>
        </div>
    );
}

function UpdateBatchRow({
    row,
    status,
    outcome,
    busy,
    pinning,
    onOpen,
}: {
    row: IUpdateBatchRow;
    status?: TUpdateInstallStatus;
    outcome?: IUpdatePinOutcome;
    busy: boolean;
    pinning: boolean;
    onOpen: () => void;
}): JSX.Element {
    return (
        <div
            role="listitem"
            aria-live="polite"
            className={'store-updates-row' + (outcome ? ` store-updates-row-${outcome.state}` : '')}
        >
            <div className="store-updates-row-main">
                <div className="store-updates-row-name">
                    {row.name}{' '}
                    <span className="store-updates-row-kind">
                        {kindLabel(row.assetKind as 'mcp' | 'plugin' | 'skill')}
                    </span>
                </div>
                <div className="store-updates-row-project">{row.projectName}</div>
            </div>
            <div className="store-updates-row-version">
                {row.from} → {row.to}
            </div>
            {status && (
                <div className={`store-updates-row-status store-updates-status-${status}`}>{STATUS_LABEL[status]}</div>
            )}
            {outcome && (
                <div className="store-updates-row-outcome">
                    {outcome.state === 'ok'
                        ? 'Закреплено'
                        : outcome.state === 'conflict'
                          ? 'Закрепление изменили параллельно'
                          : outcome.message}
                </div>
            )}
            <Button size="small" disabled={pinning} loading={busy} onClick={onOpen}>
                Открыть проект
            </Button>
        </div>
    );
}
