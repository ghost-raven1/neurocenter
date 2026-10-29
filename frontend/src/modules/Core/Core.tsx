import { BrandMark } from '../../common/components/BrandMark';
import { MenuOutlined } from '@ant-design/icons';
import { Alert, Button, Grid, Layout, Space, Typography } from 'antd';
import { FC, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSelector, useStore } from 'react-redux';
import { useHistory, useLocation } from 'react-router-dom';

import { setUnauthorizedHandler } from '../../core/api';
import { useAppDispatch } from '../../core/hooks';
import type { IMenuItem } from '../../core/interfaces';
import { LoginScreen } from '../../features/UserBlock';
import { UserInfo } from '../../features/UserBlock/components/UserInfo';
import { authInit } from '../../features/UserBlock/redux/actions';
import { signOut } from '../../features/UserBlock/redux/reducers';
import socketClient from '../../core/socket/socketClient';
import { RootState } from '../../store';
import { lazySection } from '../../common/components/LazySection';
import OperationsButton from '../Operations/OperationsButton';
import AccessibleDrawer from '../../common/components/AccessibleDrawer';
import './Core.less';
import {BridgePairing} from '../../features/McpBridge/BridgePairing';
import {selectConnectedComputer} from '../../features/McpBridge/pairingProgress';
import {useCallback} from 'react';
import {ChatLauncher} from '../../features/ModelChat/ChatLauncher';
import {useChatPresence} from '../../features/ChatActivity/useChatPresence';
import {useTabNotifications} from '../../features/TabNotifications/useTabNotifications';
import {useNotificationSounds} from '../../features/NotificationSounds/useNotificationSounds';
import {AppNavigation} from '../../features/AppNavigation/AppNavigation';
import {navigationEntries, selectedNavigationEntry} from '../../features/AppNavigation/model';
import {ComputerEnvironmentProvider} from '../../features/ComputerSetup/ComputerEnvironment';
import {ComputerHeader} from '../../features/ComputerSetup/ComputerHeader';
import {startQueryUrl} from '../Start/startQuery';

interface ICoreProps { modulesStructure: IMenuItem[]; children: ReactNode; }

const OperationsQueue = lazySection(() => import('../Operations/OperationsQueue'), 'Операции', { preserveOnNavigation: true });

/** Мониторинг показывается только при явно заданном HTTP(S)-адресе. */
const modelMonitorUrl = (() => {
    try {
        const value = import.meta.env.VITE_MODEL_MONITOR_URL?.trim();
        if (!value) { return null; }
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
})();

/** Общая оболочка: постоянная навигация на компьютере и выдвижное меню на телефоне. */
const Core: FC<ICoreProps> = ({ modulesStructure, children }) => {
    const dispatch = useAppDispatch();
    const store = useStore<RootState>();
    const history = useHistory();
    const location = useLocation();
    const screens = Grid.useBreakpoint();
    const compact = !screens.lg;
    const { isAuth, user, authorizationUnconfirmed, processing, error } = useSelector((state: RootState) => state.userBlock);
    useChatPresence(isAuth);
    useTabNotifications(isAuth, user?.email ?? '');
    useNotificationSounds(isAuth);
    const [menuOpen, setMenuOpen] = useState(false);
    const [opsOpen, setOpsOpen] = useState(false);
    const operationsTrigger = useRef<HTMLButtonElement>(null);
    const restoreOperationsFocus = useRef(false);
    const operationsRequested = new URLSearchParams(location.search).get('operations') === 'open';
    const operationsVisible = opsOpen || operationsRequested;
    const closeOperations = (): void => {
        restoreOperationsFocus.current = true;
        queueMicrotask(() => operationsTrigger.current?.focus({preventScroll: true}));
        setOpsOpen(false);
        if (operationsRequested) {
            const search = new URLSearchParams(location.search);
            search.delete('operations');
            history.replace(location.pathname + (search.size ? `?${search}` : '') + location.hash);
        }
    };
    const connectedComputer=useCallback((id:string)=>selectConnectedComputer(user?.email||'',id),[user?.email]);

    useEffect(() => { dispatch(authInit()); }, [dispatch]);
    useLayoutEffect(() => {
        // Новый успешный auth-ответ получает новую immutable identity, даже при повторном входе того же пользователя.
        setUnauthorizedHandler(() => dispatch(signOut()), () => store.getState().userBlock.user);
        return () => { setUnauthorizedHandler(() => undefined); };
    }, [dispatch, store]);
    useEffect(()=>{
        if(!isAuth){socketClient.disconnect();return;}
        const refresh=():void=>{void dispatch(authInit());};
        socketClient.connect();socketClient.on('auth:changed',refresh);socketClient.on('connect',refresh);
        return()=>{socketClient.off('auth:changed',refresh);socketClient.off('connect',refresh);};
    },[isAuth,dispatch]);

    if (!isAuth) { return <LoginScreen />; }

    const items = navigationEntries(modulesStructure, user?.routePermissions ?? []);
    const selected = selectedNavigationEntry(items, location.pathname);
    const openComputerSetup = (): void => {
        const params = new URLSearchParams(location.pathname === '/start' ? location.search : '');
        const project = new URLSearchParams(location.search).get('p');
        if (project) params.set('p', project);
        history.push(startQueryUrl(params.toString(), {setup: true, step: 1}, location.pathname === '/start' ? location.hash : ''));
    };
    const brand = <div className="app__brand"><BrandMark/><div><strong>Нейроцентр</strong><span>Рабочее пространство команды</span></div></div>;
    const menu = <AppNavigation entries={items} pathname={location.pathname} active={!compact || menuOpen}
        onNavigate={route => history.push(route)} onClose={() => setMenuOpen(false)}/>;

    return (
        <ComputerEnvironmentProvider><Layout className="app">
            <a className="app__skip" href="#main-content">Перейти к содержимому</a>
            {!compact && <Layout.Sider width={248} className="app__sidebar">{brand}{menu}<div className="app__sidebar-note">Инструменты, знания и проекты.<br />Всё необходимое для работы.{modelMonitorUrl && <a href={modelMonitorUrl} target="_blank" rel="noreferrer">Мониторинг моделей ↗</a>}</div></Layout.Sider>}
            <Layout className="app__workspace">
                <Layout.Header className="app__header">
                    <div className="app__location">{compact && <BrandMark className="app__header-mark"/>}
                        {compact && <Button type="text" icon={<MenuOutlined />} aria-label="Открыть меню" onClick={() => setMenuOpen(true)} />}
                        <Typography.Text type="secondary">Рабочее пространство</Typography.Text>
                        <span className="app__location-separator">/</span><Typography.Text strong>{selected?.title ?? 'Нейроцентр'}</Typography.Text>
                    </div>
                    <Space size={16} className="app__header-actions">
                        <ComputerHeader onSetup={openComputerSetup}/>
                        <OperationsButton triggerRef={operationsTrigger} open={operationsVisible} onClick={() => setOpsOpen(true)} />
                        <ChatLauncher/>
                        <UserInfo />
                    </Space>
                </Layout.Header>
                <Layout.Content id="main-content" tabIndex={-1} className="app__content"><div className="app__page">
                    <div className="app__authorization-status">{authorizationUnconfirmed && <Alert showIcon type="warning"
                        message="Не удалось проверить доступ" description={error}
                        action={<Button size="small" loading={processing} disabled={processing} onClick={() => dispatch(authInit())}>Повторить проверку доступа</Button>} />}</div>
                    {children}
                </div></Layout.Content>
            </Layout>
            <AccessibleDrawer title={<span className="app__drawer-brand"><BrandMark/>Нейроцентр</span>} placement="left" width={280} open={compact && menuOpen} onClose={() => setMenuOpen(false)} className="app__mobile-menu">{menu}</AccessibleDrawer>
            <AccessibleDrawer title="Операции" width={compact ? '100%' : 960} open={operationsVisible} onClose={closeOperations}
                afterOpenChange={open => {
                    if (!open && restoreOperationsFocus.current) {
                        restoreOperationsFocus.current = false;
                        // Возвращаем фокус после собственного restore внутри Ant Design 4.
                        queueMicrotask(() => operationsTrigger.current?.focus({preventScroll: true}));
                    }
                }} destroyOnClose>{operationsVisible && <OperationsQueue />}</AccessibleDrawer>
            <BridgePairing onConnected={connectedComputer}/>
        </Layout></ComputerEnvironmentProvider>
    );
};

export default Core;
