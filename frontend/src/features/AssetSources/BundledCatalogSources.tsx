import { BundledSourceCard } from './BundledSourceCard/BundledSourceCard';
import { useBundledBuildRetry } from './hooks/useBundledBuildRetry';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { FeatureButton, useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { useAuthRequestOwner } from '../UserBlock/hooks/useAuthRequestOwner';
import { useToolBuild } from '../../modules/Store/packaging/hooks/useToolBuild';
import { usePackagingPublication } from '../../modules/Store/packaging/hooks/usePackagingPublication';
import { PackagingPublicationPanel } from '../../modules/Store/packaging/PackagingPublicationPanel';
import { PackagingBuildStatus } from '../../modules/Store/packaging/PackagingBuildStatus';
import { BuildTargetChoice } from '../../modules/Store/packaging/BuildTargetChoice';
import { packagingPlatformLabels } from '../../modules/Store/packaging/platformLabels';
import {
    classifyNameConflict,
    lookupNameConflict,
    nameConflictMessages,
    type IBuildNameConflict,
} from '../../modules/Store/packaging/nameConflictRecovery';
import type { IBundledSourcePlan } from './interfaces';
import { isBatchReadyPlan } from './batchUpdate';
import { useBundledNameCheck } from './hooks/useBundledNameCheck';

/** Recipe selection reuses the existing durable build journal, cancellation and native publication CAS. */
export function BundledCatalogSources({
    plans,
    scope,
    blocked,
    onPublished,
    onImportArchive,
    prepareId,
    batchUpdate = false,
    recoverBuildId,
    plansReady = true,
}: {
    plans: IBundledSourcePlan[];
    scope: string;
    blocked: boolean;
    onPublished: () => void;
    onImportArchive: () => void;
    prepareId?: string;
    batchUpdate?: boolean;
    recoverBuildId?: string;
    plansReady?: boolean;
}): JSX.Element {
    const { captureOwner } = useAuthRequestOwner(),
        journalScope = scope + ':bundled-catalog';
    const publication = usePackagingPublication(journalScope, captureOwner),
        [conflictMessage, setConflictMessage] = useState('');
    /** Серия «Обновить готовые»: оставшиеся позиции и позиция, сборку которой отслеживаем. */
    const batchQueue = useRef<string[]>([]),
        batchCurrent = useRef<string>(),
        batchAdvanced = useRef<string>(),
        [batchHint, setBatchHint] = useState('');
    const stopBatch = (): void => {
        batchQueue.current = [];
        batchCurrent.current = undefined;
        batchAdvanced.current = undefined;
        setBatchHint('');
    };
    /** 409 занятости названия превращаем в предложение новой версии, а не в тупик. */
    const recoverNameConflict = async (conflict: IBuildNameConflict): Promise<boolean> => {
        const resolved = conflict.target
            ? {
                  catalogId: conflict.target.catalogId,
                  kind: conflict.target.kind,
                  name: '',
                  archived: conflict.target.archived,
              }
            : await lookupNameConflict(conflict.name);
        const outcome = classifyNameConflict(resolved, conflict.kind);
        if (outcome.state === 'unknown' || outcome.state === 'available') return false;
        if (outcome.state === 'archived') {
            setConflictMessage(nameConflictMessages.archived);
            return true;
        }
        if (outcome.state === 'other-kind') {
            setConflictMessage(nameConflictMessages['other-kind']);
            return true;
        }
        setConflictMessage(nameConflictMessages.match);
        void publication.select({ catalogId: outcome.catalogId, kind: outcome.kind });
        return true;
    };
    const build = useToolBuild(journalScope, recoverNameConflict);
    const [open, setOpen] = useState(false),
        [plan, setPlan] = useState<IBundledSourcePlan>(),
        [name, setName] = useState(''),
        [targets, setTargets] = useState<string[]>();
    const observed = useRef<string>();
    const openedLink = useRef<string>(),
        [linkError, setLinkError] = useState('');
    const availability = useFeatureAvailability(
        'asset_sources',
        'tool_builds',
        'tool_catalog',
        'tool_build_validation',
    );
    const retry = useBundledBuildRetry({
        scope,
        recoverBuildId,
        prepareId,
        captureOwner,
        plans,
        blocked,
        enabled: availability.enabled,
        build,
        publication,
        onPrepared: (request, original) => {
            setPlan(original);
            setName(request.name);
            setTargets(request.targets);
            setLinkError('');
        },
    });
    const { recovery, retrySource, preparingRetry, recoveryConflict, recoveryTerminal, exactPlan, prepareRetry } =
        retry;
    useEffect(() => {
        setOpen(!!recoverBuildId);
        setPlan(undefined);
        setName('');
        setTargets(undefined);
        setConflictMessage('');
        observed.current = undefined;
        stopBatch();
    }, [scope, recoverBuildId]);
    useEffect(() => {
        if (!build.draft) return;
        const request = build.draft.request;
        publication.restore(request);
        setName(request.name);
        setTargets(request.targets);
        const source = request.source;
        if (source.type === 'bundled')
            setPlan(plans.find((row) => row.id === source.id && row.revision === source.revision));
    }, [build.draft]);
    useEffect(() => {
        if (build.job?.state === 'SUCCEEDED' && observed.current !== build.job.id) {
            observed.current = build.job.id;
            onPublished();
        }
    }, [build.job?.id, build.job?.state, onPublished]);
    const retained = !!build.draft || !!build.job || build.unresolved || build.cancelPending;
    const nameCheck = useBundledNameCheck(
        scope,
        name,
        plan?.kind,
        open &&
            !blocked &&
            availability.enabled &&
            !build.active &&
            !build.recovering &&
            !build.recoveryBlocked &&
            !retained,
        captureOwner,
    );
    const locked =
        preparingRetry || build.active || build.recovering || build.recoveryBlocked || retained || nameCheck.loading;
    /** fromBatch: открываем следующую позицию серии после reset — блокировка «занято» уже снята. */
    const choose = (value: IBundledSourcePlan, fromBatch = false): void => {
        if (blocked || (!fromBatch && locked) || !captureOwner()()) return;
        // Ручной выбор другой позиции прерывает серию «Обновить готовые».
        if (batchCurrent.current && value.id !== batchCurrent.current) stopBatch();
        retry.clear();
        setPlan(value);
        setName(value.imported?.name || value.name);
        setTargets(undefined);
        setConflictMessage('');
        setOpen(true);
        if (value.imported && (value.kind === 'mcp' || value.kind === 'plugin'))
            void publication.select({ catalogId: value.imported.id, kind: value.kind });
        else publication.clear();
    };
    /** Серия: сборка текущей позиции завершена успешно — снимаем журнал и автоматически открываем следующую. */
    useEffect(() => {
        const job = build.job;
        if (
            !batchCurrent.current ||
            !job ||
            job.state !== 'SUCCEEDED' ||
            job.id === batchAdvanced.current ||
            job.recovery?.source.id !== batchCurrent.current
        )
            return;
        batchAdvanced.current = job.id;
        if (!batchQueue.current.length) {
            stopBatch();
            return;
        }
        const [nextId, ...rest] = batchQueue.current;
        void (async () => {
            // Журнал завершённой сборки отсоединяем, чтобы следующая позиция открылась без блокировки «занято».
            if (!(await build.reset())) return;
            // Если во время ожидания серию прервали (отмена, detach, смена каталога) — не продолжаем.
            if (batchCurrent.current !== job.recovery?.source.id) return;
            batchQueue.current = rest;
            batchCurrent.current = nextId;
            setBatchHint(
                rest.length
                    ? 'Серия «Обновить готовые»: после этой позиции автоматически откроется следующая. Осталось: ' +
                      rest.length
                    : 'Серия «Обновить готовые»: это последняя позиция — после неё серия завершится.',
            );
            const next = plans.find((entry) => entry.id === nextId);
            if (next) choose(next, true);
            else stopBatch();
        })();
    }, [build.job?.id, build.job?.state, plans]);
    useEffect(() => {
        if (recoverBuildId) return;
        const key = scope + ':' + prepareId;
        if (
            !prepareId ||
            openedLink.current === key ||
            build.recovering ||
            !plansReady ||
            !availability.known ||
            !captureOwner()()
        )
            return;
        openedLink.current = key;
        setLinkError('');
        if (retained || build.recoveryBlocked) {
            setOpen(true);
            return;
        }
        const value = plans.find((item) => item.id === prepareId);
        if (blocked || !availability.enabled) {
            setLinkError('Подготовка сейчас недоступна. Проверьте доступность функции и права.');
            return;
        }
        if (!value || !isBatchReadyPlan(value)) {
            setLinkError(
                'Этот исходник сейчас нельзя подготовить. Проверьте его карточку в каталоге или выберите другой исходник.',
            );
            return;
        }
        if (batchUpdate) {
            batchQueue.current = plans.filter(isBatchReadyPlan).map((entry) => entry.id).filter((entry) => entry !== value.id);
            batchCurrent.current = value.id;
            setBatchHint(
                batchQueue.current.length
                    ? 'Серия «Обновить готовые»: после этой позиции автоматически откроется следующая. Осталось: ' +
                      batchQueue.current.length
                    : '',
            );
        }
        choose(value);
    }, [
        scope,
        prepareId,
        batchUpdate,
        recoverBuildId,
        plansReady,
        build.recovering,
        build.recoveryBlocked,
        retained,
        plans,
        blocked,
        availability.enabled,
        availability.known,
        captureOwner,
    ]);
    const supported = Object.keys(packagingPlatformLabels).filter(
        (target) => !plan?.id.includes('opencode-rag') || target !== 'darwin-x64',
    );
    const submit = (): void => {
        if (
            blocked ||
            !availability.enabled ||
            locked ||
            (!!recoverBuildId && !retrySource) ||
            !plan ||
            !['mcp', 'plugin'].includes(plan.kind) ||
            !captureOwner()() ||
            publication.blocked ||
            !name.trim() ||
            targets?.length === 0
        )
            return;
        batchCurrent.current = plan.id;
        const send = async () => {
            if (!(await retry.validateRetry())) return;
            await build.submit({
                kind: plan.kind as 'mcp' | 'plugin',
                name: name.trim(),
                description: retrySource?.description ?? plan.description ?? plan.name,
                ...(retrySource ? { tags: retrySource.tags } : {}),
                source: { type: 'bundled', id: plan.id, revision: plan.revision },
                ...(targets ? { targets } : {}),
                ...(publication.selection
                    ? {
                          publication: {
                              catalogId: publication.selection.catalogId,
                              expectedVersion: publication.selection.expectedVersion,
                              expectedSourceHash: publication.selection.expectedSourceHash,
                          },
                      }
                    : {}),
            });
        };
        if (publication.selection) void send();
        else
            void nameCheck.check(send, (target) => {
                void publication.select(target);
            });
    };
    const finish = async (): Promise<void> => {
        if (await build.reset()) {
            stopBatch();
            retry.clear();
            setPlan(undefined);
            setName('');
            setTargets(undefined);
            setConflictMessage('');
            publication.clear();
            setOpen(false);
        }
    };
    if (!plans.length && !retained && !build.recoveryBlocked && !linkError && !recoverBuildId) return <></>;
    return (
        <section aria-label="Исходники текущей версии приложения">
            {linkError && <Alert type="warning" showIcon message={linkError} />}
            <Typography.Title level={3}>Исходники текущей версии</Typography.Title>
            <Typography.Paragraph type="secondary">
                Закреплённые рецепты приходят с обновлением приложения. Подготовьте пакет и проверьте результат перед
                установкой в проект.
            </Typography.Paragraph>
            {(retained || build.recoveryBlocked) && (
                <Button className="asset-sources__resume" onClick={() => setOpen(true)}>
                    Продолжить подготовку каталога
                </Button>
            )}
            <div className="asset-sources__grid">
                {plans.map((value) => (
                    <BundledSourceCard
                        key={value.id}
                        plan={value}
                        blocked={blocked}
                        locked={locked}
                        onPrepare={choose}
                        onImportArchive={() => {
                            if (captureOwner()()) onImportArchive();
                        }}
                    />
                ))}
            </div>
            <Modal
                open={open}
                title="Подготовка пакета каталога"
                onCancel={() => setOpen(false)}
                footer={
                    <Space wrap>
                        <Button onClick={() => setOpen(false)}>Скрыть</Button>
                        {build.canCancel && (
                            <Button danger loading={build.cancelling} onClick={() => void build.cancel()}>
                                Отменить сборку
                            </Button>
                        )}
                        {build.cancelPending && (
                            <Button loading={build.cancelling} onClick={() => void build.retryCancel()}>
                                Повторить отмену
                            </Button>
                        )}
                        {build.canDetach && (
                            <Button
                                loading={build.archiving}
                                onClick={() => {
                                    stopBatch();
                                    void build.detach();
                                }}
                            >
                                К другой подготовке
                            </Button>
                        )}
                        {build.unresolved && !build.cancelPending && (
                            <>
                                <Button onClick={build.recheck}>Проверить сохранённый запрос</Button>
                                <FeatureButton
                                    features={['asset_sources', 'tool_builds', 'tool_catalog', 'tool_build_validation']}
                                    disabled={blocked || !build.draft}
                                    onClick={() => void build.retrySaved()}
                                >
                                    Повторить сохранённый запрос
                                </FeatureButton>
                            </>
                        )}
                        {(build.job || build.cancelled) && !build.active && (
                            <Button onClick={() => void finish()}>К списку исходников</Button>
                        )}
                        {recoverBuildId && !retrySource && (
                            <FeatureButton
                                features={['asset_sources', 'tool_builds', 'tool_catalog', 'tool_build_validation']}
                                disabled={
                                    blocked ||
                                    !recoveryTerminal ||
                                    !exactPlan ||
                                    recoveryConflict ||
                                    build.recovering ||
                                    build.recoveryBlocked ||
                                    build.unresolved ||
                                    build.cancelPending ||
                                    preparingRetry
                                }
                                loading={preparingRetry}
                                onClick={() => void prepareRetry()}
                            >
                                Подготовить повтор этой сборки
                            </FeatureButton>
                        )}
                        {!retained && (!recoverBuildId || retrySource) && (
                            <FeatureButton
                                features={['asset_sources', 'tool_builds', 'tool_catalog', 'tool_build_validation']}
                                type="primary"
                                disabled={
                                    blocked ||
                                    locked ||
                                    !plan ||
                                    publication.blocked ||
                                    !name.trim() ||
                                    targets?.length === 0
                                }
                                onClick={submit}
                            >
                                Подготовить и опубликовать
                            </FeatureButton>
                        )}
                    </Space>
                }
            >
                {recoverBuildId && (
                    <>
                        {recovery.loading && <Typography.Text>Читаем журнал сборки…</Typography.Text>}
                        {recovery.error && (
                            <Alert
                                type="error"
                                message={recovery.error}
                                action={<Button onClick={() => void recovery.read()}>Повторить чтение</Button>}
                            />
                        )}
                        {recoveryConflict && (
                            <Alert
                                type="warning"
                                message="В журнале сохранена другая подготовка. Завершите её восстановление; текущие исходники не изменены."
                            />
                        )}
                        {recovery.job && !retrySource && (!retained || recoveryConflict) && (
                            <PackagingBuildStatus
                                job={recovery.job}
                                name={recovery.job.recovery?.name ?? ''}
                                active={open}
                                cancelPending={false}
                                cancelled={recovery.job.state === 'CANCELLED'}
                            />
                        )}
                        {recovery.job && !exactPlan && (
                            <Alert
                                type="warning"
                                message="Закреплённая версия рецепта недоступна. Текущая версия не будет подставлена вместо исходной."
                            />
                        )}
                    </>
                )}
                {retry.error && <Alert type="warning" showIcon message={retry.error} />}
                {build.error && <Alert type="error" showIcon message={build.error} />}
                {nameCheck.error && <Alert type="warning" showIcon message={nameCheck.error} />}
                {conflictMessage && <Alert type="warning" showIcon message={conflictMessage} />}
                {batchHint && <Alert type="info" showIcon message={batchHint} />}
                {nameCheck.loading && <Typography.Text>Проверяем название в каталоге…</Typography.Text>}
                {build.recoveryBlocked && (
                    <Button onClick={build.retryRecovery}>Повторить восстановление запроса</Button>
                )}
                {retained ? (
                    <PackagingBuildStatus
                        job={build.job}
                        name={build.draft?.request.name || name}
                        active={open}
                        cancelPending={build.cancelPending}
                        cancelled={build.cancelled}
                    />
                ) : (
                    <>
                        <Typography.Paragraph>
                            {plan?.name} · {plan?.sourceRevision}
                        </Typography.Paragraph>
                        <PackagingPublicationPanel
                            publication={publication}
                            disabled={locked || blocked}
                            onConfirm={() => {
                                const target = publication.confirm();
                                if (target) {
                                    setName(target.name);
                                    setConflictMessage('');
                                }
                            }}
                        />
                        <Form layout="vertical">
                            <Form.Item label="Название в каталоге">
                                <Input
                                    value={name}
                                    disabled={locked || !!publication.target}
                                    onChange={(event) => {
                                        setName(event.target.value);
                                        setConflictMessage('');
                                    }}
                                />
                            </Form.Item>
                            <BuildTargetChoice
                                value={targets}
                                supported={supported}
                                disabled={locked || blocked}
                                onChange={setTargets}
                            />
                        </Form>
                    </>
                )}
                <Typography.Paragraph type="secondary">
                    Публикация создаёт новую редакцию каталога. Применение к проекту — действие «Применить
                    обновление» на карточке инструмента в каталоге проекта.
                </Typography.Paragraph>
                {build.archived.map((record) => (
                    <Button
                        key={record.requestKey}
                        disabled={!build.canRestoreArchived}
                        onClick={() => void build.restoreArchived(record.requestKey)}
                    >
                        Вернуться к отмене: {record.name}
                    </Button>
                ))}
                {build.archiveError && (
                    <Alert
                        type="warning"
                        showIcon
                        message={build.archiveError}
                        action={<Button onClick={build.retryRecovery}>Повторить восстановление</Button>}
                    />
                )}
            </Modal>
        </section>
    );
}
