import {useCallback, useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelChatApi} from './api';
import {sortedModelChats} from './model';
import type {IModelChatConversation} from './types';

/** A private list snapshot cannot remove conversations saved after that request began. */
export function useChatIndex(projectId: string | undefined, enabled: boolean) {
    const {scope, captureOwner} = useAuthRequestOwner(), key = JSON.stringify([scope, projectId]);
    const request = useRef<AbortController>();
    const epochRef = useRef({key, sequence: 0, changes: new Map<string, {sequence: number; value: IModelChatConversation}>()});
    if (epochRef.current.key !== key) {
        request.current?.abort();
        epochRef.current = {key, sequence: 0, changes: new Map()};
    }
    const epoch = epochRef.current;
    const [state, setState] = useState({epoch, items: [] as IModelChatConversation[], loading: false, error: ''});
    const refresh = useCallback(async () => {
        if (!enabled || epochRef.current !== epoch) return;
        request.current?.abort();
        const controller = new AbortController(), owns = captureOwner(), sequence = epoch.sequence;
        request.current = controller; epoch.changes.clear();
        setState(previous => ({epoch, items: previous.epoch === epoch ? previous.items : [], loading: true, error: ''}));
        try {
            const values = await modelChatApi.list(undefined, projectId, controller.signal);
            if (owns() && !controller.signal.aborted && epochRef.current === epoch) {
                const changes = [...epoch.changes.values()].filter(change => change.sequence > sequence);
                setState(previous => {
                    const current = previous.epoch === epoch ? previous.items : [];
                    const merged = new Map(values.map(value => {const saved = current.find(item => item.id === value.id); return [value.id, saved && saved.revision > value.revision ? saved : value];}));
                    for (const change of changes) {
                        const listed = merged.get(change.value.id);
                        if (!listed || listed.revision < change.value.revision) merged.set(change.value.id, change.value);
                    }
                    return {epoch, items: sortedModelChats([...merged.values()]), loading: false, error: ''};
                });
            }
        } catch (cause) {
            if (owns() && !controller.signal.aborted && epochRef.current === epoch) setState(previous => ({...previous, error: errorMessage(cause, 'Не удалось загрузить личные диалоги.')}));
        } finally {
            if (request.current === controller) {request.current = undefined; if (owns() && epochRef.current === epoch) setState(previous => ({...previous, loading: false}));}
        }
    }, [projectId, enabled, captureOwner, epoch]);
    useEffect(() => {void refresh(); return () => {request.current?.abort(); request.current = undefined;};}, [refresh]);
    const changed = useCallback((value: IModelChatConversation | null) => {
        if (epochRef.current !== epoch || !captureOwner()()) return;
        if (!value) {void refresh(); return;}
        epoch.changes.set(value.id, {sequence: ++epoch.sequence, value});
        setState(previous => ({epoch, items: sortedModelChats(previous.epoch === epoch ? previous.items : [], value), loading: previous.epoch === epoch && previous.loading, error: previous.epoch === epoch ? previous.error : ''}));
    }, [refresh, captureOwner, epoch]);
    return {items: state.epoch === epoch ? state.items : [], loading: enabled && state.epoch === epoch && state.loading, error: state.epoch === epoch ? state.error : '', refresh, changed};
}
