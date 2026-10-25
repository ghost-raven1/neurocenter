import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {FEATURE_FLAGS_CHANGED} from '../FeatureFlags/FeatureAvailability';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {agentToolsApi} from './api';
import {agentToolsSelection, defaultAgentToolsDraft, emptyAgentToolsDraft, restoredAgentToolsDraft} from './draft';
import type {AgentToolCapabilities, AgentToolGrant, AgentToolsDraft} from './types';
const drafts = new Map<string, AgentToolsDraft>();
/** Actor/project/chat own the draft and capability read. Opening controls performs read-only discovery. */
export function useAgentTools(ownerKey: string, projectId?: string) {
    const {scope,captureOwner} = useAuthRequestOwner(), owner = JSON.stringify([scope,projectId,ownerKey]), live = useRef(owner); live.current = owner;
    const initial = () => drafts.get(owner) ?? emptyAgentToolsDraft();
    const [state,setState] = useState({owner,draft: initial()}), [read,setRead] = useState<{owner: string; capabilities?: AgentToolCapabilities; error?: string; loading: boolean}>({owner,loading: !!projectId}), [revision,setRevision] = useState(0);
    const draft = state.owner === owner ? state.draft : initial(), current = useRef(draft); current.current = draft;
    const update = (change: Partial<AgentToolsDraft>): void => {
        if (live.current !== owner) return;
        const next = {...current.current,...change,initialized: true,restored: undefined}; current.current = next; drafts.set(owner,next); setState({owner,draft: next});
    };
    useEffect(() => {
        if (!projectId) return;
        const abort = new AbortController(), owns = captureOwner(); setRead({owner,loading: true});
        void agentToolsApi.capabilities(projectId,abort.signal).then(capabilities => {
            if (abort.signal.aborted || !owns() || live.current !== owner) return;
            const next = defaultAgentToolsDraft(current.current,capabilities); current.current = next; drafts.set(owner,next); setState({owner,draft: next}); setRead({owner,capabilities,loading: false});
        }).catch(cause => {if (!abort.signal.aborted && owns() && live.current === owner) setRead({owner,loading: false,error: errorMessage(cause,'Инструменты пока не подтвердили доступность. Проверьте состояние или выключите их для обычного ответа.')});});
        return () => abort.abort();
    }, [owner,projectId,revision]);
    useEffect(() => {if (typeof window === 'undefined') return; const reload = () => setRevision(value => value + 1); window.addEventListener(FEATURE_FLAGS_CHANGED,reload); return () => window.removeEventListener(FEATURE_FLAGS_CHANGED,reload);}, []);
    useSectionUpdates(['maintenance'],() => setRevision(value => value + 1),!!projectId);
    const result = read.owner === owner ? read : {loading: !!projectId,capabilities: undefined,error: undefined}, selected = agentToolsSelection(draft,result.capabilities);
    const restore = (grant?: AgentToolGrant): void => {if (live.current !== owner) return; const next = restoredAgentToolsDraft(grant); current.current = next; drafts.set(owner,next); setState({owner,draft: next});};
    const afterSubmission = (): (() => void) => {const submitted = current.current, owns = captureOwner(); return () => {
        if (live.current !== owner || !owns() || current.current !== submitted) return;
        update({publicChats: false,consent: false,enabled: submitted.rag || submitted.systemRoles});
    };};
    return {draft,capabilities: result.capabilities,loading: result.loading,error: result.error,blocked: !!projectId && (result.loading && !draft.initialized || draft.enabled && (!!result.error || !!selected.reason || result.loading)),reason: draft.enabled ? result.error || selected.reason : undefined,
        request: projectId && !result.loading && !result.error ? selected.request : undefined,update,restore,afterSubmission,
        reload: () => setRevision(value => value + 1),disable: () => update({enabled: false})};
}
