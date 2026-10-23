import {useEffect} from 'react';
import api from '../../core/api/base';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {chatWindowActive, nextChatSession} from './session';

/** Presence follows the authenticated app, rather than an individual open room. */
export function useChatPresence(authenticated: boolean): void {
    const {scope, captureOwner} = useAuthRequestOwner(), flag = useFeatureAvailability('chat_activity');
    useEffect(() => {
        if (!authenticated || !flag.enabled) return;
        const owns = captureOwner();
        let online = false;
        const publish = (value: boolean): void => {
            online = value;
            void api.put('/api/chat-presence/session', {...nextChatSession(), online: value}, {timeout: 15000}).catch(() => undefined);
        };
        const update = (): void => {
            if (!owns()) return;
            const value = chatWindowActive();
            if (value || online) publish(value);
        };
        const leave = (): void => {if (owns()) publish(false);};
        update();
        const timer = setInterval(update, 10000);
        window.addEventListener('focus', update); window.addEventListener('blur', leave); window.addEventListener('pagehide', leave);
        document.addEventListener('visibilitychange', update);
        return () => {
            clearInterval(timer); window.removeEventListener('focus', update); window.removeEventListener('blur', leave); window.removeEventListener('pagehide', leave);
            document.removeEventListener('visibilitychange', update); leave();
        };
    }, [authenticated, scope, captureOwner, flag.enabled]);
}
