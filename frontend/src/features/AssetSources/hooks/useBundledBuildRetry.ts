import { useEffect, useRef, useState } from 'react';
import { useBundledBuildRecovery } from './useBundledBuildRecovery';
import type { IBundledBuildRecovery } from '../../../modules/Store/packaging/interfaces';
import type { IBundledBuildRetryOptions } from './useBundledBuildRetry.interfaces';

/** Restore an exact terminal request only after a fresh read, preserving another journal owner. */
export function useBundledBuildRetry({
    scope,
    recoverBuildId,
    prepareId,
    captureOwner,
    plans,
    blocked,
    enabled,
    build,
    publication,
    onPrepared,
}: IBundledBuildRetryOptions) {
    const recovery = useBundledBuildRecovery(scope, recoverBuildId, prepareId, captureOwner);
    const [storedRetry, setStoredRetry] = useState<{ key: string; value: IBundledBuildRecovery }>();
    const [preparingRetry, setPreparingRetry] = useState(false);
    const preparing = useRef(false);
    const [error, setError] = useState('');
    const retryContext = `${scope}:${recoverBuildId}:${prepareId}`;
    const retrySource = storedRetry?.key === retryContext ? storedRetry.value : undefined;
    const currentRetry = useRef({ key: retryContext, allowed: !blocked && enabled, build, plans });
    currentRetry.current = { key: retryContext, allowed: !blocked && enabled, build, plans };
    useEffect(() => {
        setStoredRetry(undefined);
        setPreparingRetry(false);
        preparing.current = false;
        setError('');
    }, [retryContext]);
    const retained = !!build.draft || !!build.job || build.unresolved || build.cancelPending;
    const recoveryConflict =
        !!recoverBuildId &&
        retained &&
        build.job?.id !== recoverBuildId &&
        build.draft?.request.requestKey !== recovery.job?.requestKey;
    const recoveryTerminal = !!recovery.job && ['FAILED', 'CANCELLED'].includes(recovery.job.state);
    const exactPlan =
        recovery.job?.recovery &&
        plans.find(
            (value) =>
                value.id === recovery.job!.recovery!.source.id &&
                value.revision === recovery.job!.recovery!.source.revision,
        );
    const prepareRetry = async (): Promise<void> => {
        if (
            preparing.current ||
            blocked ||
            !enabled ||
            recoveryConflict ||
            build.recovering ||
            build.recoveryBlocked ||
            build.unresolved ||
            build.cancelPending
        )
            return;
        const authOwns = captureOwner();
        const owns = () => authOwns() && currentRetry.current.key === retryContext && currentRetry.current.allowed;
        preparing.current = true;
        setPreparingRetry(true);
        try {
            const fresh = await recovery.read();
            if (!owns()) return;
            const request = fresh?.recovery;
            const original =
                request &&
                currentRetry.current.plans.find(
                    (value) => value.id === request.source.id && value.revision === request.source.revision,
                );
            if (!fresh || !request || !original || !['FAILED', 'CANCELLED'].includes(fresh.state)) {
                setError('Повтор недоступен: проверьте состояние сборки и доступность её закреплённого рецепта.');
                setPreparingRetry(false);
                return;
            }
            const latest = currentRetry.current.build;
            const latestRetained = !!latest.draft || !!latest.job || latest.unresolved || latest.cancelPending;
            if (
                latest.recovering ||
                latest.recoveryBlocked ||
                latest.unresolved ||
                latest.cancelPending ||
                (latestRetained && latest.job?.id !== fresh.id && latest.draft?.request.requestKey !== fresh.requestKey)
            ) {
                setError('Журнал подготовки изменился. Сохранённый запрос не заменён.');
                return;
            }
            if (latestRetained && !(await latest.reset())) {
                setPreparingRetry(false);
                return;
            }
            if (!owns()) return;
            setStoredRetry({ key: retryContext, value: request });
            onPrepared(request, original);
            setError('');
            if (request.publication)
                await publication.select({ catalogId: request.publication.catalogId, kind: request.kind });
            else publication.clear();
        } finally {
            if (currentRetry.current.key === retryContext) {
                preparing.current = false;
                setPreparingRetry(false);
            }
        }
    };
    const validateRetry = async (): Promise<boolean> => {
        const owns = captureOwner();
        const valid = () => owns() && currentRetry.current.key === retryContext && currentRetry.current.allowed;
        if (!valid()) return false;
        if (!retrySource) return !recoverBuildId;
        const fresh = await recovery.read();
        const okay =
            valid() &&
            !!fresh &&
            ['FAILED', 'CANCELLED'].includes(fresh.state) &&
            fresh.recovery?.source.revision === retrySource.source.revision;
        if (valid() && !okay) setError('Состояние исходной сборки изменилось. Новая сборка не отправлена.');
        return okay;
    };
    return {
        recovery,
        retrySource,
        preparingRetry,
        recoveryConflict,
        recoveryTerminal,
        exactPlan,
        prepareRetry,
        validateRetry,
        error,
        clear: () => setStoredRetry(undefined),
    };
}
