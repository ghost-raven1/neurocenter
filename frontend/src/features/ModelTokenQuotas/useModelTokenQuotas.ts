import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {quotaApi} from './api';
import {createQuotaController} from './controller';
import {initialQuotaState} from './model';
import {quotaStorageKey} from './storage';
import type {QuotaIdentity, QuotaStorage} from './types';

/** Remount identity and synchronous auth ownership fence model/user/session changes, including late receipts. */
export function useModelTokenQuotas(identity: QuotaIdentity, onPrivacyDenied?: () => void) {
    const {captureOwner} = useAuthRequestOwner(), [state, setState] = useState(initialQuotaState);
    const privacy = useRef(onPrivacyDenied); privacy.current = onPrivacyDenied;
    const {scope, writerEmail, modelId, userEmail} = identity;
    const controller = useMemo(() => {
        let storage: QuotaStorage | undefined; try {storage = window.localStorage;} catch { /* Controller exposes read-only recovery and a storage error. */ }
        return createQuotaController({scope, writerEmail, modelId, userEmail, captureOwner, storage, onChange: setState, onPrivacyDenied: () => privacy.current?.(),
            api: {read: signal => quotaApi.read(modelId, userEmail, signal), write: (input, signal) => quotaApi.write(modelId, userEmail, input, signal), receipt: (key, signal) => quotaApi.receipt(modelId, userEmail, key, signal)}});
    }, [scope, writerEmail, modelId, userEmail, captureOwner]);
    useLayoutEffect(() => {
        controller.activate(); void controller.initialize();
        const changed = (event: StorageEvent): void => {if (event.key === null || event.key === quotaStorageKey(identity)) controller.storageChanged();};
        window.addEventListener('storage', changed);
        return () => {window.removeEventListener('storage', changed); controller.dispose();};
    }, [controller, scope, writerEmail, modelId, userEmail]);
    return {state, controller};
}
