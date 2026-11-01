import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { packagingApi } from '../../../modules/Store/packaging/api';
import type { IToolBuild } from '../../../modules/Store/packaging/interfaces';
import { errorMessage } from '../../../common/utils/errorMessage';

/** Read the exact job without creating a request; discard responses from an earlier owner or link. */
export function useBundledBuildRecovery(
    scope: string,
    id: string | undefined,
    sourceId: string | undefined,
    captureOwner: () => () => boolean,
) {
    const key = `${scope}:${id}:${sourceId}`;
    const owner = useMemo(() => ({ key, captureOwner, active: true }), [key, captureOwner]);
    const current = useRef(owner);
    current.current = owner;
    const generation = useRef(0);
    const [state, setState] = useState<{ key: string; job?: IToolBuild; error: string; loading: boolean }>({
        key,
        error: '',
        loading: false,
    });
    const read = useCallback(async (): Promise<IToolBuild | undefined> => {
        const owns = captureOwner(),
            sequence = ++generation.current;
        if (!id || !owns()) return;
        const valid = () => current.current === owner && owner.active && generation.current === sequence && owns();
        setState({ key, error: '', loading: true });
        try {
            if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
                throw new Error('Некорректная ссылка на сборку.');
            const job = await packagingApi.get(id);
            if (!valid()) return;
            if (job.id !== id || !job.recovery || job.recovery.source.id !== sourceId)
                throw new Error('Точный рецепт этой сборки недоступен. Откройте её журнал в операциях.');
            setState({ key, job, error: '', loading: false });
            return job;
        } catch (cause) {
            if (valid())
                setState({
                    key,
                    error: errorMessage(cause, 'Не удалось восстановить сборку. Повторите чтение журнала.'),
                    loading: false,
                });
        }
    }, [captureOwner, id, key, owner, sourceId]);
    useEffect(() => {
        owner.active = true;
        void read();
        return () => {
            owner.active = false;
        };
    }, [read, owner]);
    return { ...(state.key === key ? state : { key, error: '', loading: !!id }), read };
}
