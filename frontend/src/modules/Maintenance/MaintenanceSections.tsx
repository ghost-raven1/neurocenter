import {Tabs} from 'antd';
import {useEffect, useRef, type ReactNode} from 'react';
import {useHistory, useLocation} from 'react-router-dom';

type MaintenanceTab = 'backups' | 'storage' | 'features';
const tabs: MaintenanceTab[] = ['backups', 'storage', 'features'];
const hashTab = (hash: string): MaintenanceTab | undefined => /^(#maintenance-(schedule|windows|retention)-title|#maintenance-backups)$/.test(hash) ? 'backups'
    : hash === '#maintenance-features' ? 'features' : hash === '#maintenance-storage' ? 'storage' : undefined;

/** Task navigation keeps every editor mounted, including pending requests and unsaved input. */
export function MaintenanceSections({backups, storage, features}: {backups: ReactNode; storage: ReactNode; features: ReactNode}): JSX.Element {
    const history = useHistory(), location = useLocation(), container = useRef<HTMLDivElement>(null);
    const requested = new URLSearchParams(location.search).get('tab') as MaintenanceTab;
    const active = hashTab(location.hash) ?? (tabs.includes(requested) ? requested : 'backups');
    useEffect(() => {
        if (!hashTab(location.hash) || !container.current) return;
        let frame: number | undefined, observer: MutationObserver | undefined;
        const reveal = (): boolean => {
            const target = document.getElementById(location.hash.slice(1));
            if (!target || !container.current?.contains(target)) return false;
            frame = requestAnimationFrame(() => target.scrollIntoView({block: 'start'})); return true;
        };
        // Forms may arrive after the route; scroll after their first layout.
        if (!reveal()) {
            observer = new MutationObserver(() => {if (reveal()) observer?.disconnect();});
            observer.observe(container.current, {childList: true, subtree: true});
        }
        return () => {observer?.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame);};
    }, [location.hash, active]);
    const change = (key: string): void => {
        const search = new URLSearchParams(location.search); search.set('tab', key);
        const hash = hashTab(location.hash) && hashTab(location.hash) !== key ? '' : location.hash;
        history.replace(location.pathname + '?' + search.toString() + hash);
    };
    return <div ref={container}><Tabs className="maintenance-page__sections" aria-label="Задачи обслуживания" activeKey={active} onChange={change} destroyInactiveTabPane={false} items={[
        {key: 'backups', label: 'Резервные копии', forceRender: true, children: <div id="maintenance-backups">{backups}</div>},
        {key: 'storage', label: 'Хранилища', forceRender: true, children: <div id="maintenance-storage">{storage}</div>},
        {key: 'features', label: 'Функции платформы', forceRender: true, children: <div id="maintenance-features">{features}</div>},
    ]} /></div>;
}
