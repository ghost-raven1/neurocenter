import {useEffect, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {modelChatApi} from './api';
import type {IChatResearchChoices, IChatResearchRequest} from './types';

/** A request pins explicit sources; opening these controls never starts a model or a search. */
export function researchSelection(project: boolean, externalId: string | undefined, choices?: IChatResearchChoices): {request?: IChatResearchRequest; reason?: string} {
    if (!choices) return {reason: 'Загрузите доступные источники исследования.'};
    if (project && !choices.project.available) return {reason: choices.project.reason || 'Поиск по проекту недоступен.'};
    const external = externalId ? choices.external.find(item => item.assetId === externalId) : undefined;
    if (externalId && (!external || !external.available)) return {reason: external?.reason || 'Выбранный поисковый MCP больше не назначен проекту.'};
    if (!project && !external) return {reason: 'Выберите хотя бы один источник исследования.'};
    return {request: {project, ...(external ? {external: {assetId: external.assetId, version: external.version, manifest: external.manifest}} : {})}};
}

export function useChatResearch(modelId: string, projectId: string | undefined, conversationId: string | undefined, captureOwner: () => () => boolean) {
    const [enabled, setEnabled] = useState(false), [project, setProject] = useState(true), [externalId, setExternalId] = useState<string>();
    const [choices, setChoices] = useState<IChatResearchChoices>(), [loading, setLoading] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
    useEffect(() => {
        if (!enabled || !projectId) return;
        const abort = new AbortController(), owns = captureOwner(); setLoading(true); setError(''); setChoices(undefined);
        void modelChatApi.researchChoices(modelId, projectId, abort.signal, conversationId)
            .then(value => {if (owns() && !abort.signal.aborted) setChoices(value);})
            .catch(cause => {if (owns() && !abort.signal.aborted) setError(errorMessage(cause, 'Не удалось загрузить источники. Обычный чат доступен без исследования.'));})
            .finally(() => {if (owns() && !abort.signal.aborted) setLoading(false);});
        return () => abort.abort();
    }, [enabled, modelId, projectId, conversationId, refresh]);
    const selected = researchSelection(project, externalId, choices);
    const reason = !projectId ? 'Выберите проект для исследования.' : loading ? 'Загружаем источники…' : error || selected.reason;
    const reset = (): void => {setEnabled(false); setProject(true); setExternalId(undefined); setError('');};
    const restore = (request?: IChatResearchRequest): void => {setEnabled(!!request); setProject(request?.project ?? true); setExternalId(request?.external?.assetId);};
    return {enabled, setEnabled, project, setProject, externalId, setExternalId, choices, loading, error, reason,
        request: enabled && !reason ? selected.request : undefined, reset, restore, reload: () => setRefresh(refresh + 1)};
}
