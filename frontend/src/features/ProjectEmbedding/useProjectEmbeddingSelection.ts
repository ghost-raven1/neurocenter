import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { projectEmbeddingApi, type IProjectEmbedding } from './model';

interface ISelectionRead { key: string; selection?: IProjectEmbedding; loading: boolean; error: string; }

/** Чтение подключения изолировано от каталога; старый проект или owner не подтверждает новый выбор. */
export function useProjectEmbeddingSelection(projectId?: string) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const key = JSON.stringify([scope, projectId]);
    const [state, setState] = useState<ISelectionRead>({ key, loading: !!projectId, error: '' });
    const sequence = useRef(0), active = useRef(true);
    const refresh = useCallback(async () => {
        const owns = captureOwner();
        if (!projectId || !active.current || !owns()) return;
        const ticket = ++sequence.current, current = () => active.current && ticket === sequence.current && owns();
        setState(previous => ({ key, selection: previous.key === key ? previous.selection : undefined, loading: true, error: '' }));
        try {
            const selection = await projectEmbeddingApi.read(projectId);
            if (current()) setState({ key, selection, loading: false, error: '' });
        } catch (cause) {
            if (current()) setState(previous => ({ ...previous, key, loading: false,
                error: errorMessage(cause, 'Не удалось проверить подключение модели проекта.') }));
        }
    }, [captureOwner, key, projectId]);
    useEffect(() => {
        active.current = true; void refresh();
        return () => { active.current = false; sequence.current++; };
    }, [refresh]);
    useSectionUpdates(['catalog', 'projects', 'access'], () => { void refresh(); }, !!projectId);
    return { selection: state.key === key ? state.selection : undefined,
        loading: !!projectId && (state.key !== key || state.loading), error: state.key === key ? state.error : '', refresh };
}
