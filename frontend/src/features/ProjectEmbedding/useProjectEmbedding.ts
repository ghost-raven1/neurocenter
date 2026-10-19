import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { modelCatalogApi } from '../ModelCatalog/api';
import { requireModelCatalog } from '../ModelCatalog/modelCatalogState';
import type { IModelCatalog } from '../ModelCatalog/types';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { embeddingNeedsRepair, projectEmbeddingApi, type IProjectEmbedding } from './model';

/** Выбор сохраняется по CAS; поздний GET или ответ закрытой формы не меняет новый контекст. */
export function useProjectEmbedding(projectId: string) {
    const { captureOwner } = useAuthRequestOwner();
    const [selection, setSelection] = useState<IProjectEmbedding>();
    const [catalog, setCatalog] = useState<IModelCatalog>();
    const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
    const [readError, setReadError] = useState(''), [saveError, setSaveError] = useState('');
    const [draft, setDraft] = useState<string | null | undefined>();
    const active = useRef(true), sequence = useRef(0), lock = useRef(false);
    const refresh = useCallback(async () => {
        const owns = captureOwner(); if (!active.current || lock.current || !owns()) return;
        const ticket = ++sequence.current; const current = () => active.current && ticket === sequence.current && owns();
        setLoading(true);
        try {
            const [next, models] = await Promise.all([projectEmbeddingApi.read(projectId), modelCatalogApi.list(projectId)]);
            const checked = requireModelCatalog(models);
            if (current()) { setSelection(next); setCatalog(checked); setReadError(''); }
        } catch (cause) { if (current()) setReadError(errorMessage(cause, 'Не удалось загрузить модель проекта.')); }
        finally { if (current()) setLoading(false); }
    }, [captureOwner, projectId]);
    useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; sequence.current++; }; }, [refresh]);
    useSectionUpdates(['catalog', 'projects', 'access'], () => { void refresh(); });
    const modelId = draft === undefined ? selection?.model?.id ?? null : draft;
    const save = async () => {
        const owns = captureOwner();
        if (!owns() || !active.current || lock.current || loading || readError || !selection
            || modelId === (selection.model?.id ?? null) && !embeddingNeedsRepair(selection)) return;
        lock.current = true; const ticket = ++sequence.current;
        const current = () => active.current && ticket === sequence.current && owns();
        setSaving(true); setSaveError('');
        try {
            const next = await projectEmbeddingApi.save(projectId, selection.revision, modelId);
            if (current()) { setSelection(next); setDraft(undefined); }
        } catch (cause) { if (current()) setSaveError(errorMessage(cause, 'Не удалось сохранить модель. Обновите сведения перед повтором.')); }
        finally { lock.current = false; if (current()) setSaving(false); }
    };
    return { selection, catalog, loading, saving, readError, saveError, modelId, refresh, save,
        choose: (id: string | null) => { if (!lock.current) { setDraft(id); setSaveError(''); } } };
}
