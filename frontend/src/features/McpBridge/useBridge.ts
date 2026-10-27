import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import socket from '../../core/socket/socketClient';
import { bridgeApi, type IBridgeDevice, type IBridgeJob,type IBridgeInstallation } from './api';
import { readBridgeResources, type TBridgeErrors, type TBridgeReadResult, type TBridgeResource } from './bridgeRead';
import {CONNECTED_DEVICE_EVENT} from './pairingProgress';
import { authDataScope } from '../UserBlock/authDataScope';

const emptyErrors = (): TBridgeErrors => ({ devices: '', jobs: '', installations: '' });
const STATUS_MAX_AGE_MS = 30000;

/** Личные статусы MCP обновляются событиями, после reconnect читается сохранённая очередь. */
export function useBridge(enabled=true) {
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
    const [devicesCheckedAt, setDevicesCheckedAt] = useState<number>();
    const [, expireStatus] = useState(0);
    const generation = useRef(0);
    const pendingGeneration = useRef<number>();
    const reload = useCallback(async ({skipIfPending = false} = {}) => {
        if (!enabled || !email || scopeRef.current !== scope || skipIfPending && pendingGeneration.current !== undefined) { return; }
        const seq = ++generation.current;
        pendingGeneration.current = seq;
        setLoading(true);
        const receive = <T,>(resource: TBridgeResource, result: TBridgeReadResult<T>, save: (items: T[]) => void): void => {
            if (seq !== generation.current || scopeRef.current !== scope) { return; }
            if (result.ok) {
                save(result.data);
                if (resource === 'devices') { setDevicesCheckedAt(Date.now()); }
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
            if (pendingGeneration.current === seq) { pendingGeneration.current = undefined; }
            if (seq === generation.current && scopeRef.current === scope) {
                setLoading(false);
            }
        }
    }, [email, scope,enabled]);
    useEffect(() => {
        if (devicesCheckedAt === undefined) { return; }
        // Даже зависший запрос не оставляет подтверждённый online у старого снимка.
        const timer = setTimeout(() => expireStatus(value => value + 1), Math.max(0, devicesCheckedAt + STATUS_MAX_AGE_MS - Date.now()));
        return () => clearTimeout(timer);
    }, [devicesCheckedAt]);
    useEffect(() => {
        generation.current++;
        pendingGeneration.current = undefined;
        setOwner(scope);
        setDevices([]);
        setJobs([]);
        setInstallations([]);
        setErrors(emptyErrors());
        setLoaded({ devices: false, jobs: false, installations: false });
        setDevicesCheckedAt(undefined);
        setLoading(true);
        try {
            setSelected(
                localStorage.getItem('neurocenter.device.' + email) || '',
            );
        } catch {
            setSelected('');
        }
        if (!enabled || !email) {
            setLoading(false);
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = (): void => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                void reload({skipIfPending: true});
            }, 150);
        };
        void reload();
        socket.connect();
        socket.on('bridge:changed', refresh);
        socket.on('connect', refresh);
        const paired=(event:Event):void=>{const id=(event as CustomEvent<string>).detail;if(typeof id==='string'){setSelected(id);void reload();}};
        window.addEventListener(CONNECTED_DEVICE_EVENT,paired);
        const resume = (): void => {
            if (document.visibilityState !== 'visible') { return; }
            if (timer) { clearTimeout(timer); }
            void reload({skipIfPending: true});
        };
        window.addEventListener('focus', resume);
        document.addEventListener('visibilitychange', resume);
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
            window.removeEventListener('focus', resume);
            document.removeEventListener('visibilitychange', resume);
        };
    }, [email, reload,enabled]);
    const choose = (id: string): void => {
        setSelected(id);
        try {
            localStorage.setItem('neurocenter.device.' + email, id);
        } catch {
            /* Приватный режим браузера. */
        }
    };
    const current = owner === scope;
    // Срок снимка считается от получения ответа: часы сервера и браузера могут различаться.
    const statusAge = devicesCheckedAt === undefined ? Infinity : Date.now() - devicesCheckedAt;
    const statusFresh = statusAge >= 0 && statusAge < STATUS_MAX_AGE_MS;
    const devicesReady = current && loaded.devices && !errors.devices && statusFresh;
    const visibleDevices = current ? devicesReady ? devices : devices.map(item => ({ ...item, online: false })) : [];
    const device = visibleDevices.find((item) => item.id === selected) || (visibleDevices.length === 1 ? visibleDevices[0] : undefined);
    const jobsReady = current && loaded.jobs && !errors.jobs;
    const installationsReady = current && loaded.installations && !errors.installations;
    const visibleErrors = current ? { ...errors, devices: errors.devices || (loaded.devices && !statusFresh ? 'Статус подключения устарел. Проверьте подключение снова.' : '') } : emptyErrors();
    const error = visibleErrors.devices || visibleErrors.jobs || visibleErrors.installations;
    return { devices: visibleDevices, device, jobs: current ? jobs : [], installations: current ? installations : [], error, errors: visibleErrors,
        devicesReady, jobsReady, installationsReady, loading: !current || loading, reload, choose };
}
