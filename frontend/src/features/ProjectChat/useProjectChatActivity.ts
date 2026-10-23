import {useCallback, useEffect, useRef, useState} from 'react';
import {isAxiosError} from 'axios';
import socketClient from '../../core/socket/socketClient';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {chatWindowActive, nextChatSession} from '../ChatActivity/session';
import {projectChatActivityApi} from './activityApi';
import type {ProjectChatActivity} from './activity.types';
import {DEFAULT_PROJECT_CHAT_ROOM, type ProjectChatDetail} from './types';

interface Result {owner: string; snapshot?: ProjectChatActivity; connected: boolean;}

/** Room activity never starts inference and never treats a history fetch as proof of reading. */
export function useProjectChatActivity(projectId: string, roomId: string, detail: ProjectChatDetail | undefined, onDenied: () => void) {
    const {scope, captureOwner} = useAuthRequestOwner(), flag = useFeatureAvailability('chat_activity', 'project_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const]));
    const owner = JSON.stringify([scope, projectId, roomId]);
    const [result, setResult] = useState<Result>({owner, connected: false});
    const currentOwner = useRef(owner); currentOwner.current = owner;
    const latest = useRef({detail, onDenied}); latest.current = {detail, onDenied};
    const commands = useRef({typing: (_body: string) => undefined as void, visible: (_ids: string[], _currentVisible?: () => string[]) => undefined as void, refresh: () => undefined as void});
    const available = !!detail;
    useEffect(() => {
        if (!available) {setResult({owner, connected: false}); return;}
        const ownsAuth = captureOwner(), controllers = new Set<AbortController>();
        let active = true, generation = 0, acceptedRead = 0, snapshot: ProjectChatActivity | undefined;
        let draft = '', typing = false, lastTypedAt = 0, lastSentAt = 0;
        let typingTimer: ReturnType<typeof setTimeout> | undefined, readTimer: ReturnType<typeof setTimeout> | undefined;
        const watched = new Set<string>(), pending = new Set<string>(), acknowledged = new Set<string>();
        let currentVisible = (): string[] => [...watched];
        const owns = (): boolean => active && ownsAuth() && currentOwner.current === owner;
        const denied = (cause: unknown): boolean => isAxiosError(cause) && [401, 403, 404].includes(cause.response?.status ?? 0);
        const failure = (cause: unknown, authoritative = false): void => {
            if (!owns()) return;
            if (authoritative && denied(cause)) {
                active = false; controllers.forEach(controller => controller.abort());
                setResult({owner, connected: false}); latest.current.onDenied();
            } else setResult(previous => previous.owner === owner ? {...previous, connected: false} : previous);
        };
        const refresh = async (): Promise<void> => {
            if (!owns()) return;
            const read = ++generation, controller = new AbortController(); controllers.add(controller);
            const tail = latest.current.detail?.messages.filter(message => message.kind === 'user').slice(-100).map(message => message.id) ?? [];
            const ids = [...new Set([...watched, ...tail])].slice(0, 100);
            try {
                const value = await projectChatActivityApi.read(projectId, roomId, ids, controller.signal);
                if (!owns() || controller.signal.aborted || read < acceptedRead || value.roomId !== roomId) return;
                acceptedRead = read;
                const receipts = new Map(snapshot?.receipts.map(receipt => [receipt.messageId, receipt]) ?? []);
                value.receipts.forEach(receipt => receipts.set(receipt.messageId, receipt));
                snapshot = {...value, receipts: [...receipts.values()]};
                setResult({owner, snapshot, connected: true});
            } catch (cause) {if (!controller.signal.aborted && read >= acceptedRead) failure(cause, true);}
            finally {controllers.delete(controller);}
        };
        const publish = (online: boolean, visibleMessageIds: string[] = []): void => {
            if (!owns() || !flag.enabled) return;
            const controller = new AbortController(); controllers.add(controller);
            const input = {...nextChatSession(), online, typing: online && typing, ...(visibleMessageIds.length ? {visibleMessageIds} : {})};
            void projectChatActivityApi.update(projectId, roomId, input, controller.signal).then(() => {
                if (!owns() || controller.signal.aborted) return;
                visibleMessageIds.forEach(id => {acknowledged.add(id); pending.delete(id);});
                if (visibleMessageIds.length) void refresh();
            }).catch(cause => {if (!controller.signal.aborted) {
                failure(cause);
                // A write may be disabled while history remains readable. Verify ACL through GET.
                if (owns() && denied(cause)) {void flag.refresh?.(); void refresh();}
            }}).finally(() => controllers.delete(controller));
        };
        const flushReads = (): void => {
            readTimer = undefined;
            if (!owns() || !flag.enabled || !chatWindowActive()) return;
            const visibleNow = new Set(currentVisible());
            const ids = [...pending].filter(id => watched.has(id) && visibleNow.has(id)).slice(0, 100);
            pending.forEach(id => {if (!visibleNow.has(id)) pending.delete(id);});
            if (ids.length) publish(true, ids);
        };
        const stopTyping = (): void => {
            clearTimeout(typingTimer); typingTimer = undefined; draft = '';
            if (typing) {typing = false; publish(false);}
        };
        commands.current = {
            refresh: () => {void refresh();},
            typing: body => {
                draft = body;
                if (!flag.enabled || !body.trim() || !chatWindowActive()) {stopTyping(); return;}
                const now = Date.now(); lastTypedAt = now;
                if (!typing || now - lastSentAt >= 3000) {typing = true; lastSentAt = now; publish(true);}
                clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 4500);
            },
            visible: (ids, recheck) => {
                if (!owns()) return;
                currentVisible = recheck ?? (() => [...watched]);
                watched.clear(); ids.forEach(id => watched.add(id));
                pending.forEach(id => {if (!watched.has(id)) pending.delete(id);});
                if (!flag.enabled || !snapshot || !chatWindowActive()) return;
                const incoming = new Set(latest.current.detail?.messages.filter(message => message.kind === 'user' && message.author?.email !== snapshot!.viewerEmail).map(message => message.id));
                ids.forEach(id => {if (incoming.has(id) && !acknowledged.has(id)) pending.add(id);});
                if (pending.size && !readTimer) readTimer = setTimeout(flushReads, 250);
            },
        };
        const focus = (): void => {if (chatWindowActive()) void refresh(); else {pending.clear(); stopTyping();}};
        const blur = (): void => {pending.clear(); stopTyping();};
        const disconnected = (): void => {if (owns()) setResult(previous => previous.owner === owner ? {...previous, connected: false} : previous);};
        const poll = setInterval(() => {
            if (document.visibilityState === 'visible') void refresh();
            if (typing && draft.trim() && chatWindowActive() && Date.now() - lastTypedAt < 4500 && Date.now() - lastSentAt >= 3000) {lastSentAt = Date.now(); publish(true);}
            if (pending.size && !readTimer) flushReads();
        }, 2000);
        void refresh();
        window.addEventListener('blur', blur); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
        socketClient.on('disconnect', disconnected); socketClient.on('connect_error', disconnected); socketClient.on('connect', focus);
        return () => {
            active = false; generation++; clearInterval(poll); clearTimeout(typingTimer); clearTimeout(readTimer); controllers.forEach(controller => controller.abort());
            window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
            socketClient.off('disconnect', disconnected); socketClient.off('connect_error', disconnected); socketClient.off('connect', focus);
            if (flag.enabled && ownsAuth()) void projectChatActivityApi.update(projectId, roomId, {...nextChatSession(), online: false, typing: false}).catch(() => undefined);
        };
    }, [owner, projectId, roomId, available, captureOwner, flag.enabled]);
    useSectionUpdates(['project_chat', 'access'], () => commands.current.refresh(), available);
    const onTyping = useCallback((body: string) => commands.current.typing(body), []);
    const onVisible = useCallback((ids: string[], currentVisible?: () => string[]) => commands.current.visible(ids, currentVisible), []);
    return {snapshot: available && result.owner === owner ? result.snapshot : undefined, connected: result.owner === owner && result.connected, enabled: flag.enabled, onTyping, onVisible};
}
