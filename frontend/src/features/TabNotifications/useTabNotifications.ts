import {useLayoutEffect} from 'react';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {readTabSnapshot} from './read';
import {mountTabBadge} from './tabBadge';
import {tabNotifications} from './tracker';
import {TAB_PENDING_POLL_MS} from './types';

/** Core owns a single serial reader across hidden tabs and closed chat overlays. */
export function useTabNotifications(authenticated: boolean, email: string) {
    const {scope, captureOwner} = useAuthRequestOwner(), availability = useFeatureAvailability('tab_notifications');
    useLayoutEffect(() => {
        const active = authenticated && availability.enabled && !!scope;
        const release = tabNotifications.configure(scope, email, active), badge = mountTabBadge(document), owns = captureOwner();
        let disposed = false, request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        const update = (): void => {if (!disposed && owns()) badge.update(tabNotifications.count());};
        const visible = (): void => {tabNotifications.setHidden(document.visibilityState === 'hidden');};
        const unsubscribe = tabNotifications.subscribe(update);
        visible();
        const poll = async (): Promise<void> => {
            if (disposed || !owns()) {if (!disposed) badge.update(0); return;}
            const source = tabNotifications.next(scope);
            if (source) {
                const current = tabNotifications.captureRead(scope, source);
                const controller = new AbortController(); request = controller;
                let timedOut = false, abortRead = (): void => undefined;
                const cancelled = new Promise<never>((_resolve, reject) => {
                    abortRead = () => reject(new DOMException('Status read aborted', 'AbortError'));
                    controller.signal.addEventListener('abort', abortRead, {once: true});
                });
                const deadline = setTimeout(() => {timedOut = true; controller.abort();}, 10000);
                try {
                    const value = await Promise.race([readTabSnapshot(source, controller.signal, tabNotifications.pendingIds(scope, source)), cancelled]);
                    if (!disposed && owns() && current() && !controller.signal.aborted) {tabNotifications.accept(scope, value); tabNotifications.defer(scope, source);}
                } catch (cause) {
                    if (!disposed && owns() && current() && (!controller.signal.aborted || timedOut)) {
                        const status = (cause as {response?: {status?: number}})?.response?.status;
                        if (status && [401, 403, 404].includes(status)) tabNotifications.forget(scope, source);
                        else tabNotifications.defer(scope, source, true);
                    }
                } finally {clearTimeout(deadline); controller.signal.removeEventListener('abort', abortRead); if (request === controller) request = undefined;}
            }
            if (!disposed && owns()) timer = setTimeout(() => {void poll();}, TAB_PENDING_POLL_MS);
        };
        if (active) {document.addEventListener('visibilitychange', visible); timer = setTimeout(() => {void poll();}, TAB_PENDING_POLL_MS);}
        return () => {disposed = true; if (timer) clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visible); unsubscribe(); release(); badge.dispose();};
    }, [authenticated, email, scope, captureOwner, availability.enabled]);
}
