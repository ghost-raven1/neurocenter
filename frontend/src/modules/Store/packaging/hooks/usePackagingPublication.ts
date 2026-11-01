import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../../../common/utils/errorMessage';
import { packagingApi } from '../api';
import type {
    IBuildPublicationTargetPreview,
    TPackagingKind,
    IToolBuildPublication,
    IToolBuildRequest,
} from '../interfaces';

type TTarget = { catalogId: string; kind: TPackagingKind };
export interface IPackagingPublicationSelection extends IToolBuildPublication {
    name: string;
    kind: TPackagingKind;
}
interface IState {
    target?: TTarget;
    preview?: IBuildPublicationTargetPreview;
    selection?: IPackagingPublicationSelection;
    loading: boolean;
    error: string;
}
const empty: IState = { loading: false, error: '' };

/** Цель обновления читается отдельно от источника и меняется только по явному действию. */
export function usePackagingPublication(scope: string, captureOwner: () => () => boolean) {
    const [state, setState] = useState<IState>(empty);
    const owner = useMemo(() => ({}), [scope, captureOwner]);
    const currentOwner = useRef(owner);
    currentOwner.current = owner;
    const sequence = useRef(0),
        flight = useRef<AbortController>();
    const snapshot = useRef(state);
    snapshot.current = state;
    useEffect(() => {
        setState(empty);
        return () => {
            sequence.current++;
            flight.current?.abort();
        };
    }, [owner]);
    const load = async (target: TTarget): Promise<void> => {
        if (currentOwner.current !== owner || !captureOwner()()) return;
        const request = ++sequence.current,
            owns = captureOwner();
        flight.current?.abort();
        const controller = new AbortController();
        flight.current = controller;
        const current = () => currentOwner.current === owner && request === sequence.current && owns();
        setState({ target, loading: true, error: '' });
        try {
            const preview = await packagingApi.publicationTarget(target, controller.signal);
            if (!current()) return;
            if (preview.catalogId !== target.catalogId || preview.kind !== target.kind)
                throw new Error('Сервер вернул другую цель публикации. Повторите проверку.');
            setState({ target, preview, loading: false, error: '' });
        } catch (cause) {
            if (current())
                setState({
                    target,
                    loading: false,
                    error: errorMessage(
                        cause,
                        'Не удалось проверить текущую версию. Повторите проверку цели. Исходники сохранены в форме.',
                    ),
                });
        }
    };
    const confirm = (): IBuildPublicationTargetPreview | undefined => {
        const value = snapshot.current;
        if (currentOwner.current !== owner || !captureOwner()() || !value.preview?.updateSupported || value.loading)
            return;
        const { catalogId, expectedVersion, expectedSourceHash, name, kind } = value.preview;
        setState({ ...value, selection: { catalogId, expectedVersion, expectedSourceHash, name, kind } });
        return value.preview;
    };
    const restore = (request: IToolBuildRequest): void => {
        if (currentOwner.current !== owner || !captureOwner()()) return;
        sequence.current++;
        flight.current?.abort();
        setState(
            request.publication
                ? {
                      target: { catalogId: request.publication.catalogId, kind: request.kind },
                      selection: { ...request.publication, name: request.name, kind: request.kind },
                      loading: false,
                      error: '',
                  }
                : empty,
        );
    };
    const clear = (): void => {
        if (currentOwner.current !== owner || !captureOwner()()) return;
        sequence.current++;
        flight.current?.abort();
        setState(empty);
    };
    return {
        ...state,
        blocked: !!state.target && !state.selection,
        select: load,
        confirm,
        restore,
        clear,
        refresh: () => {
            const target = snapshot.current.target;
            if (target && currentOwner.current === owner) void load(target);
        },
    };
}
