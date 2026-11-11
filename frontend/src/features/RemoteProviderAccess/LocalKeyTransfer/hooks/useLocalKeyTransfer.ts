import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { TRootState } from '../../../../store';
import base from '../../../../core/api/base';
import { useAuthRequestOwner } from '../../../UserBlock/hooks/useAuthRequestOwner';
import { durableJournalOwner } from '../../../UserBlock/durableJournalOwner';
import { roleLevel } from '../../../UserBlock/roles';
import { useFeatureAvailability } from '../../../FeatureFlags/FeatureAvailability';
import { browserCliJournalLock } from '../../../ComputerSetup/journalLock';
import type { useBridge } from '../../../McpBridge/hooks/useBridge';
import { localKeyTransferApi } from '../api';
import { OPENCODE_PERSONAL_KEY_CAPABILITY } from '../contract';
import type { ILocalKeyTransferProps, ITransferState } from '../interfaces';
import { createLocalKeyTransferController } from './controller';

/** Public browser state tracks only the recipient and window receipt; the manual secret draft stays with its owner. */
export function useLocalKeyTransfer(bridge: ReturnType<typeof useBridge>, input: ILocalKeyTransferProps) {
    const user = useSelector((state: TRootState) => state.userBlock.user),
        { scope, captureOwner } = useAuthRequestOwner();
    const availability = useFeatureAvailability(
        'opencode_personal_key_transfer',
        'personal_remote_provider_credentials',
        'computer_connections',
    );
    const device = bridge.device,
        deviceId = device?.id ?? '',
        modelId = input.view.modelId;
    const owner = durableJournalOwner(user, base.defaults.baseURL || window.location.origin),
        role = user?.activeRole ?? '';
    const identity = JSON.stringify([
        scope,
        deviceId,
        modelId,
        input.view.providerId,
        input.view.connectionRevision,
        input.view.credentialRevision,
    ]);
    const current = useRef(identity);
    current.current = identity;
    const allowed =
        !!owner &&
        !!scope &&
        !!device &&
        bridge.devicesReady &&
        !bridge.errors.devices &&
        device.online &&
        !device.requiresReconnect &&
        user?.userRoles.includes(role) &&
        roleLevel(role) >= 2 &&
        roleLevel(device.role) >= 2 &&
        device.report.capabilities?.includes(OPENCODE_PERSONAL_KEY_CAPABILITY);
    const canOpen =
        !!allowed &&
        availability.enabled &&
        !input.busy &&
        !input.manualPending &&
        input.view.canStoreKey &&
        input.view.authMode !== 'none';
    const latest = useRef({ input, canOpen });
    latest.current = { input, canOpen };
    const lock = useMemo(browserCliJournalLock, []);
    const [snapshot, setSnapshot] = useState<{ identity: string; state?: ITransferState }>({ identity });
    const controller = useMemo(() => {
        let storage: Storage | undefined;
        try {
            storage = localStorage;
        } catch {
            /* History cannot authorize a new send without a durable journal. */
        }
        return createLocalKeyTransferController({
            owner,
            role,
            deviceId,
            modelId,
            storage,
            lock,
            api: localKeyTransferApi,
            captureOwner: () => {
                const owns = captureOwner();
                return () => owns() && current.current === identity;
            },
            canOpen: () => latest.current.canOpen && !!lock,
            target: () => latest.current.input.view,
            onChange: (state) => setSnapshot({ identity, state }),
            onSaved: () => {
                if (current.current === identity) void latest.current.input.onUpdated();
            },
        });
    }, [owner, role, deviceId, modelId, identity, lock, captureOwner]);
    useEffect(() => {
        controller.activate();
        void controller.refresh();
        const changed = (event: StorageEvent) => {
            if (event.key === null || event.key === controller.journalKey) void controller.refresh();
        };
        window.addEventListener('storage', changed);
        return () => {
            controller.dispose();
            window.removeEventListener('storage', changed);
        };
    }, [controller]);
    const state = snapshot.identity === identity ? snapshot.state : undefined;
    const pending = !!state?.intent && !state.receipt;
    useEffect(() => {
        if (!pending) return;
        const timer = window.setInterval(() => {
            if (document.visibilityState !== 'hidden') void controller.refresh();
        }, 3000);
        return () => window.clearInterval(timer);
    }, [controller, pending]);
    const reason = !availability.enabled
        ? availability.reason
        : input.manualPending
          ? 'Сначала проверьте прежнее сохранение личного ключа.'
          : !input.view.canStoreKey
            ? 'Хранилище личных ключей не настроено.'
            : !allowed
              ? 'Выберите доступный компьютер с действующей ролью и обновлённым мостом.'
              : !lock
                ? 'Браузер не поддерживает защищённый журнал открытия.'
                : '';
    return { state, controller, canOpen: canOpen && !!lock, reason, ownerEmail: user?.email ?? '' };
}
