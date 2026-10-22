import { useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { bridgeApi, type IInstallPlan } from '../../../features/McpBridge/api';
import { errorMessage } from '../../../common/utils/errorMessage';
import { useSectionUpdates } from '../../../core/socket/useSectionUpdates';
import type { IStoreApp } from '../../../features/Catalog/types';
import { approveInstallation, prepareInstallation, refreshInstallationPlan, revokeInstallationPlan, type IPlanExecution } from './installPlanFlow';
import { parseInstallPlanFailure, type IInstallPlanFailure } from './installPlanFailure';

interface IInstallContext {
    scopeKey: string;
    deviceId?: string;
    projectId?: string;
    bindingId?: string;
    ready: boolean;
    canApprove: boolean;
    captureOwner(): () => boolean;
    isPending(app: IStoreApp): boolean;
    prepareCatalog?(app: IStoreApp, current: () => boolean): Promise<boolean>;
    planBlocker?(plan: IInstallPlan): string;
    reload(): Promise<unknown>;
}
interface IReview { plan: IInstallPlan; app: IStoreApp; installOnApprove: boolean; scopeKey: string }
type TAction = 'install' | 'inspect' | 'approve' | 'revoke';
interface IFailure extends IInstallPlanFailure { scopeKey: string; action: 'install' | 'inspect'; request: number }

/** Контекст и номер запроса не позволяют старой модалке писать в другой проект. */
export function useInstallPlan(context: IInstallContext) {
    const [review, setReview] = useState<IReview | null>(null);
    const [failure, setFailure] = useState<IFailure | null>(null);
    const [busy, setBusy] = useState('');
    const currentScope = useRef(context.scopeKey);
    currentScope.current = context.scopeKey;
    const sequence = useRef(0);
    const lock = useRef(false);
    const requests = useRef(new Map<string, string>());
    const reviewRef = useRef<IReview | null>(null);
    const latestContext = useRef(context); latestContext.current = context;
    const refreshSequence = useRef(0);
    const refreshPending = useRef(false);
    const updateReview = (value: IReview | null): void => { reviewRef.current = value; setReview(value); };

    const cancel = (): void => {
        sequence.current += 1;
        refreshSequence.current += 1;
        refreshPending.current = false;
        lock.current = false;
        updateReview(null);
        setFailure(null);
        setBusy('');
    };
    useEffect(() => {
        cancel();
        requests.current.clear();
        return () => { sequence.current += 1; lock.current = false; };
    }, [context.scopeKey]);

    const refreshReview = async (): Promise<void> => {
        const opened = reviewRef.current;
        if (!opened || opened.scopeKey !== currentScope.current) { return; }
        if (lock.current) { refreshPending.current = true; return; }
        const token = sequence.current;
        const refresh = ++refreshSequence.current;
        const current = (): boolean => token === sequence.current && refresh === refreshSequence.current
            && !lock.current && opened.scopeKey === currentScope.current && reviewRef.current?.plan.id === opened.plan.id;
        try {
            const next = await refreshInstallationPlan(opened.plan, bridgeApi.plan, current);
            if (next && current()) {
                const latest = reviewRef.current!;
                if (next.revision >= latest.plan.revision) { updateReview({ ...latest, plan: next }); }
            }
        } catch (cause) {
            if (current()) { message.error(errorMessage(cause, 'Не удалось обновить разрешение версии. Повторите открытие плана.')); }
        }
    };
    useSectionUpdates(['catalog'], () => { void refreshReview(); }, !!review && review.scopeKey === context.scopeKey);
    useEffect(() => { void refreshReview(); }, [review?.plan.id, review?.scopeKey]);

    const execute = async (app: IStoreApp, action: TAction, plan?: IInstallPlan): Promise<void> => {
        const installs = action === 'install' || action === 'approve' && !!review?.installOnApprove;
        const owner = context.captureOwner();
        if (!owner() || context.scopeKey !== currentScope.current || lock.current || !context.projectId || (action !== 'install' && !context.canApprove)
            || installs && (!context.ready || !context.deviceId || context.isPending(app))) { return; }
        lock.current = true;
        setFailure(null);
        refreshSequence.current += 1;
        setBusy(app.id);
        const token = ++sequence.current;
        const scope = context.scopeKey;
        const current = (): boolean => token === sequence.current && scope === currentScope.current && owner();
        const execution: IPlanExecution = {
            api: bridgeApi,
            current,
            prepareCatalog: context.prepareCatalog ? async () => {
                if (!await context.prepareCatalog!(app, current) || !current()) { return false; }
                const live = latestContext.current;
                if (!live.ready || live.isPending(app)) { throw new Error('Подключение или очередь изменились. Дождитесь актуального статуса и повторите установку.'); }
                return true;
            } : undefined,
            enqueue: async approved => {
                if (!current()) { return; }
                if (!installs) { updateReview({ plan: approved, app, installOnApprove: false, scopeKey: scope }); return; }
                const live = latestContext.current;
                const blocked = live.planBlocker?.(approved);
                if (blocked) { updateReview({plan:approved,app,installOnApprove:true,scopeKey:scope}); throw new Error(blocked); }
                if (!live.ready || live.isPending(app)) { throw new Error('Подключение или очередь изменились. Дождитесь актуального статуса и повторите установку.'); }
                const key = [context.deviceId, context.projectId, approved.id, approved.manifest, approved.revision].join(':');
                const requestKey = requests.current.get(key) || crypto.randomUUID();
                requests.current.set(key, requestKey);
                await bridgeApi.create({ deviceId: context.deviceId!, projectId: approved.projectId,
                    kind: 'install', requestKey, assetId: approved.assetId, assetKind: approved.assetKind,
                    expectedBindingId: context.bindingId,
                    version: approved.version, planId: approved.id, planRevision: approved.revision });
                requests.current.delete(key);
                if (current()) { updateReview(null); await context.reload(); }
            },
        };
        try {
            if (plan && action === 'revoke') {
                const revoked = await revokeInstallationPlan(plan, bridgeApi.revokePlan, current);
                if (revoked && current()) { updateReview({ plan: revoked, app, installOnApprove: false, scopeKey: scope }); }
            }
            else if (plan) { await approveInstallation(plan, execution); }
            else {
                const pending = await prepareInstallation({ projectId: context.projectId, assetId: app.id,
                    assetKind: app.kind, version: app.version }, execution, action === 'inspect');
                if (current() && pending) { updateReview({ plan: pending, app, installOnApprove: installs, scopeKey: scope }); }
            }
        } catch (cause) {
            if (current()) {
                const issue = parseInstallPlanFailure(cause, app);
                if (issue && (action === 'install' || action === 'inspect')) {
                    updateReview(null);
                    setFailure({ app, issue, action, scopeKey: scope, request: token });
                } else { message.error(errorMessage(cause, 'Не удалось подготовить установку через мост.')); }
            }
        } finally {
            if (current()) {
                lock.current = false; setBusy('');
                if (refreshPending.current) { refreshPending.current = false; void refreshReview(); }
            }
        }
    };
    return {
        busy, review: review?.scopeKey === context.scopeKey ? review : null, cancel,
        failure: failure?.scopeKey === context.scopeKey ? failure : null,
        retryFailure: () => failure?.scopeKey === currentScope.current && failure.request === sequence.current
            ? execute(failure.app, failure.action) : Promise.resolve(),
        install: (app: IStoreApp) => execute(app, 'install'),
        inspect: (app: IStoreApp) => execute(app, 'inspect'),
        approve: () => review ? execute(review.app, 'approve', review.plan) : Promise.resolve(),
        revoke: () => review ? execute(review.app, 'revoke', review.plan) : Promise.resolve(),
        installReviewed: () => review ? execute(review.app, 'install') : Promise.resolve(),
        installDisabled: !context.ready || !!review && context.isPending(review.app),
        installBlocker: review ? context.planBlocker?.(review.plan) || '' : '',
    };
}
