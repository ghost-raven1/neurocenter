import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { roleLevel } from '../UserBlock/roles';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { bridgeApi, type IBridgeDevice } from './api';
import { createRuntimeCacheSettings, initialRuntimeCacheSettings, type RuntimeCacheSettingsState } from './runtimeCacheSettingsController';

/** One device and auth scope own the draft, pending receipt and polling lifetime. */
export function useRuntimeCacheSettings(device: IBridgeDevice) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const role = useSelector((state: RootState) => {
        const user = state.userBlock.user;
        return user && user.userRoles.includes(user.activeRole) ? user.activeRole : null;
    });
    const validRole = !!role;
    const availability = useFeatureAvailability('computer_connections');
    const cleanupAvailability = useFeatureAvailability('bridge_storage_cleanup');
    const supportsCleanup = !!device.report.capabilities?.includes('bridge-update-cleanup-v1');
    const supportsTarget = !!device.report.capabilities?.includes('runtime-cache-target-v2');
    const reason = !validRole ? 'Подтвердите текущую роль и подключение компьютера.'
        : roleLevel(role) < 2 ? 'Для новых действий выберите роль разработчика или администратора.' : device.requiresReconnect ? 'Подключите компьютер заново.'
        : !device.report.capabilities?.includes('runtime-cache-policy-v1') && !supportsTarget ? 'Обновите мост, чтобы управлять кэшем комплектов.'
        : !device.online ? 'Включите компьютер и дождитесь подключения моста.' : '';
    const latest = useRef({reason, setReason: reason || availability.reason, cleanupReason: reason || cleanupAvailability.reason, supportsCleanup, supportsTarget});
    latest.current = {reason, setReason: reason || availability.reason, cleanupReason: reason || cleanupAvailability.reason, supportsCleanup, supportsTarget};
    const key = JSON.stringify([scope, device.id]);
    const [view, setView] = useState<{key: string; state: RuntimeCacheSettingsState}>({key, state: initialRuntimeCacheSettings()});
    const controller = useMemo(() => createRuntimeCacheSettings({scope, deviceId: device.id, captureOwner,
        storage: {getItem: name => localStorage.getItem(name), setItem: (name, value) => localStorage.setItem(name, value), removeItem: name => localStorage.removeItem(name)},
        create: bridgeApi.create, jobs: bridgeApi.jobs, inspectReason: () => latest.current.reason, setReason: () => latest.current.setReason,
        cleanupSupported: () => latest.current.supportsCleanup, cleanupReason: enabled => enabled ? latest.current.cleanupReason : latest.current.reason,
        targetSupported: () => latest.current.supportsTarget,
        onChange: state => setView({key, state})}), [key, scope, device.id, captureOwner]);
    useLayoutEffect(() => {controller.activate(); return () => controller.dispose();}, [controller]);
    const state = view.key === key ? view.state : initialRuntimeCacheSettings();
    const pending = !!state.intent;
    useEffect(() => {
        if (!state.intent?.jobId || state.job && ['succeeded', 'failed', 'cancelled'].includes(state.job.state)) return;
        const timer = setInterval(() => {void controller.refresh();}, 1500);
        return () => clearInterval(timer);
    }, [controller, state.intent?.jobId, state.job?.state]);
    return {...state, pending, reason, setReason: latest.current.setReason, cleanupReason: latest.current.cleanupReason, supportsCleanup, supportsTarget, canRecover: validRole, ...controller};
}
