import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import type {useBridge} from '../McpBridge/useBridge';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {roleLevel} from '../UserBlock/roles';
import {cliObservationApi} from './api';
import {createCliObservationController} from './controller';
import {cliObservationBlocker} from './eligibility';
import {browserCliJournalLock} from './journalLock';
import {cliTerminal, cliUuid, initialCliObservation} from './model';
import {cliStorageKey, type CliStorage} from './storage';

/** Auth and selected ID fence async work; heartbeat objects never create another automatic request. */
export function useCliObservation(bridge: ReturnType<typeof useBridge>, masterEnabled: boolean, automatic = true) {
    const {scope, captureOwner} = useAuthRequestOwner(), user = useSelector((value: RootState) => value.userBlock.user);
    const availability = useFeatureAvailability('computer_setup', 'computer_connections');
    const email = user?.email ?? '', role = user?.activeRole ?? '', deviceId = bridge.device?.id ?? '';
    const identity = JSON.stringify([scope, deviceId]), selected = useRef(identity); selected.current = identity;
    const assignedRole = !!user?.userRoles.includes(role), lock = useMemo(browserCliJournalLock, []);
    const proofSupported = !!globalThis.crypto?.subtle && typeof globalThis.crypto?.randomUUID === 'function';
    const blocker = cliObservationBlocker({device: bridge.device, verified: bridge.devicesReady && !bridge.errors.devices, assignedRole, role,
        enabled: availability.enabled, reason: availability.reason, masterEnabled});
    const canStart = !blocker && !!lock && proofSupported;
    const automaticAllowed = useRef(automatic); automaticAllowed.current = automatic;
    const latest = useRef({canStart, canCancel: false}); latest.current = {canStart, canCancel: assignedRole && roleLevel(role) >= 1 && cliUuid(deviceId)};
    const [result, setResult] = useState({identity, state: initialCliObservation()});
    const controller = useMemo(() => {
        let storage: CliStorage | undefined; try {storage = window.localStorage;} catch { /* Reads remain available without a writable journal. */ }
        return createCliObservationController({email, role, deviceId, api: cliObservationApi, storage, lock,
            canStart: () => latest.current.canStart, canCancel: () => latest.current.canCancel,
            captureOwner: () => {const owns = captureOwner(); return () => owns() && selected.current === identity;},
            onChange: state => setResult({identity, state})});
    }, [scope, email, role, deviceId, captureOwner, lock]);
    useLayoutEffect(() => {
        controller.activate();
        if (scope && email && cliUuid(deviceId)) void controller.refresh().then(() => {if (automaticAllowed.current) return controller.automatic();});
        const changed = (event: StorageEvent): void => {if (event.key === null || event.key === cliStorageKey(email, deviceId)) controller.storageChanged();};
        window.addEventListener('storage', changed);
        return () => {window.removeEventListener('storage', changed); controller.dispose();};
    }, [controller, scope, email, deviceId]);
    useEffect(() => {if (canStart && automatic) void controller.automatic();}, [controller, canStart, automatic]);
    const state = result.identity === identity ? result.state : initialCliObservation();
    useEffect(() => {
        if (cliTerminal(state.job) || !state.intent && !state.job || state.canReplay || state.denied || state.storageError) return;
        const timer = window.setInterval(() => {if (document.visibilityState !== 'hidden') void controller.check();}, 2500);
        return () => window.clearInterval(timer);
    }, [controller, state.intent?.request.requestKey, state.job?.id, state.job?.state, state.canReplay, state.denied, state.storageError]);
    const browserBlocker = !lock || !proofSupported ? 'Автопроверка недоступна в этом браузере. Откройте сайт в актуальном браузере по HTTPS или через localhost; историю можно читать.' : '';
    return {state, controller, blocker: blocker || browserBlocker, canStart, canCancel: latest.current.canCancel, roleChanged: !!state.intent && state.intent.role !== role};
}
