import {useCallback, useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {agentCatalogApi} from '../AgentCatalog/api';
import type {IProjectAgent} from '../AgentCatalog/types';
import {modelCatalogApi} from '../ModelCatalog/api';
import type {ICatalogModel} from '../ModelCatalog/types';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';

/** Optional model/agent metadata cannot erase recorded experience when its catalog is unavailable. */
export function useLearningResources(projectId: string, enabled: boolean) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const context = JSON.stringify([scope, projectId]), current = useRef(context); current.current = context;
    const sequence = useRef(0);
    const [models, setModels] = useState<ICatalogModel[]>([]), [agents, setAgents] = useState<IProjectAgent[]>([]);
    const [loading, setLoading] = useState(true), [error, setError] = useState('');
    const refresh = useCallback(async () => {
        const owns = captureOwner(), ticket = ++sequence.current;
        const active = (): boolean => owns() && current.current === context && sequence.current === ticket;
        if (!owns() || !enabled) return;
        setLoading(true);
        const results = await Promise.allSettled([modelCatalogApi.list(projectId), agentCatalogApi.list(projectId)]);
        if (!active()) return;
        const [modelResult, agentResult] = results;
        if (modelResult.status === 'fulfilled' && Array.isArray(modelResult.value.items) && Array.isArray(modelResult.value.assignedModelIds))
            setModels(modelResult.value.items.filter(model => modelResult.value.assignedModelIds.includes(model.id) && ['chat', 'vision'].includes(model.capability) && !model.archivedAt));
        else setModels([]);
        if (agentResult.status === 'fulfilled' && Array.isArray(agentResult.value.assignments)) setAgents(agentResult.value.assignments.filter(agent => !agent.removed));
        else setAgents([]);
        const failed = results.find(result => result.status === 'rejected');
        setError(failed?.status === 'rejected' ? errorMessage(failed.reason, 'Не удалось загрузить доступные модели или агентов.') : ''); setLoading(false);
    }, [captureOwner, context, projectId, enabled]);
    useEffect(() => {setModels([]); setAgents([]); setError(''); void refresh(); return () => {sequence.current++;};}, [refresh]);
    useSectionUpdates(['catalog', 'projects', 'access'], () => {void refresh();}, enabled);
    return {models, agents, loading, error, refresh};
}
