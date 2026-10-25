import {useLayoutEffect, useSyncExternalStore} from 'react';
import {useSelector, useStore} from 'react-redux';
import type {RootState} from '../../store';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {tabNotifications} from '../TabNotifications/tracker';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {soundPrincipal} from './preferences';
import {notificationSounds} from './runtime';

/** Audio follows Core; closing settings or a chat leaves confirmed background cues available. */
export function useNotificationSounds(authenticated: boolean): void {
    const {scope, captureOwner} = useAuthRequestOwner(), flags = useFeatureAvailability('notification_sounds', 'tab_notifications');
    const user = useSelector((state: RootState) => state.userBlock.user), principal = soundPrincipal(user), store = useStore<RootState>();
    useLayoutEffect(() => {
        const owns = captureOwner(), release = notificationSounds.configure(scope, principal, authenticated && flags.enabled, owns);
        const completed = tabNotifications.subscribeCompletion(notificationSounds.notify);
        const configured = tabNotifications.subscribeConfiguration(notificationSounds.silence);
        const authority = store.subscribe(() => {if (!owns()) notificationSounds.silence();});
        return () => {authority(); configured(); completed(); release();};
    }, [authenticated, scope, principal, captureOwner, flags.enabled, store]);
}

/** Shared personal controls consume the same runtime without acquiring another audio owner. */
export function useNotificationSoundSettings() {
    const {scope, captureOwner} = useAuthRequestOwner(), flag = useFeatureAvailability('notification_sounds', 'tab_notifications');
    const principal = soundPrincipal(useSelector((state: RootState) => state.userBlock.user));
    const state = useSyncExternalStore(notificationSounds.subscribe, notificationSounds.snapshot, notificationSounds.snapshot);
    return {state: principal && state.principal === principal ? state : undefined, flag,
        change: (patch: Parameters<typeof notificationSounds.change>[2]): void => {if (captureOwner()()) notificationSounds.change(scope, principal, patch);},
        test: (): void => {if (captureOwner()() && flag.enabled) notificationSounds.test(scope, principal);}};
}
