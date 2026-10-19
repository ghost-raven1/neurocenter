import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import socket from '../../core/socket/socketClient';
import { bridgeApi, type IBridgeDevice, type IBridgeJob,type IBridgeInstallation } from './api';
import { readBridgeResources, type TBridgeErrors, type TBridgeReadResult, type TBridgeResource } from './bridgeRead';
import {CONNECTED_DEVICE_EVENT} from './pairingProgress';
import { authDataScope } from '../UserBlock/authDataScope';

const emptyErrors = (): TBridgeErrors => ({ devices: '', jobs: '', installations: '' });

/** Личные статусы MCP обновляются событиями, после reconnect читается сохранённая очередь. */
export function useBridge() {
    const email =
        useSelector((state: RootState) => state.userBlock.user?.email) || '';
    const scope = useSelector((state: RootState) => state.userBlock.user ? authDataScope({ user: state.userBlock.user, policies: state.userBlock.policies }) : '');
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const [owner, setOwner] = useState(scope);
    const [devices, setDevices] = useState<IBridgeDevice[]>([]);
    const [jobs, setJobs] = useState<IBridgeJob[]>([]);
    const [installations,setInstallations]=useState<IBridgeInstallation[]>([]);
    const [selected, setSelected] = useState('');
    const [errors, setErrors] = useState<TBridgeErrors>(emptyErrors);
    const [loaded, setLoaded] = useState({ devices: false, jobs: false, installations: false });
    const [loading, setLoading] = useState(true);
    const generation = useRef(0);
    const reload = useCallback(async () => {
        if (!email || scopeRef.current !== scope) { return; }
        const seq = ++generation.current;
        setLoading(true);
        const receive = <T,>(resource: TBridgeResource, result: TBridgeReadResult<T>, save: (items: T[]) => void): void => {
            if (seq !== generation.current || scopeRef.current !== scope) { return; }
            if (result.ok) {
                save(result.data);
                setLoaded(previous => ({ ...previous, [resource]: true }));
                setErrors(previous => ({ ...previous, [resource]: '' }));
            } else {
                if (result.accessDenied) {
                    save([]);
                    setLoaded(previous => ({ ...previous, [resource]: false }));
                }
                setErrors(previous => ({ ...previous, [resource]: result.error }));
            }
        };
        try {
            await readBridgeResources(bridgeApi, {
                devices: result => receive('devices', result, setDevices),
                jobs: result => receive('jobs', result, setJobs),
                installations: result => receive('installations', result, setInstallations),
            });
        } finally {
            if (seq === generation.current && scopeRef.current === scope) {
                setLoading(false);
            }
        }
    }, [email, scope]);
    useEffect(() => {
        generation.current++;
        setOwner(scope);
        setDevices([]);
        setJobs([]);
        setInstallations([]);
        setErrors(emptyErrors());
        setLoaded({ devices: false, jobs: false, installations: false });
        setLoading(true);
        try {
            setSelected(
                localStorage.getItem('neurocenter.device.' + email) || '',
            );
        } catch {
            setSelected('');
        }
        if (!email) {
            setLoading(false);
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = (): void => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                void reload();
            }, 150);
        };
        void reload();
        socket.connect();
        socket.on('bridge:changed', refresh);
        socket.on('connect', refresh);
        const paired=(event:Event):void=>{const id=(event as CustomEvent<string>).detail;if(typeof id==='string'){setSelected(id);refresh();}};
        window.addEventListener(CONNECTED_DEVICE_EVENT,paired);
        // Вкладка, открытая после сна компьютера, проверяет и online TTL, и очередь.
        const fallback = setInterval(() => {
            if (document.visibilityState === 'visible') {
                refresh();
            }
        }, 15000);
        return () => {
            generation.current++;
            if (timer) {
                clearTimeout(timer);
            }
            clearInterval(fallback);
            socket.off('bridge:changed', refresh);
            socket.off('connect', refresh);
            window.removeEventListener(CONNECTED_DEVICE_EVENT,paired);
        };
    }, [email, reload]);
    const choose = (id: string): void => {
        setSelected(id);
        try {
            localStorage.setItem('neurocenter.device.' + email, id);
        } catch {
            /* Приватный режим браузера. */
        }
    };
    const current = owner === scope;
    const visibleDevices = current ? devices : [];
    const device = visibleDevices.find((item) => item.id === selected) || (visibleDevices.length === 1 ? visibleDevices[0] : undefined);
    const devicesReady = current && loaded.devices && !errors.devices;
    const jobsReady = current && loaded.jobs && !errors.jobs;
    const installationsReady = current && loaded.installations && !errors.installations;
    const visibleErrors = current ? errors : emptyErrors();
    const error = visibleErrors.devices || visibleErrors.jobs || visibleErrors.installations;
    return { devices: visibleDevices, device, jobs: current ? jobs : [], installations: current ? installations : [], error, errors: visibleErrors,
        devicesReady, jobsReady, installationsReady, loading: !current || loading, reload, choose };
}
