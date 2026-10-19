import { Alert, Button, Card, Collapse, Input, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { PageHeading } from '../../common/components/PageHeading';
import { errorMessage } from '../../common/utils/errorMessage';
import bffApi from '../../core/api/bff';
import type { IAccessDecision, IAccessUserRow } from '../../core/api/interfaces';
import { useAppDispatch } from '../../core/hooks';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { authInit } from '../../features/UserBlock/redux/actions';
import { isMainAdminRole, projectRoleLevel } from '../../features/UserBlock/roles';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import type { RootState } from '../../store';
import AccessGrantModal from './AccessGrantModal';
import PlatformUsers from './PlatformUsers';
import { fetchDecisions } from './redux/actions';
import './Access.less';

const ACTION_LABELS: Record<string, string> = {
    'platform.admin': 'Управление системой',
    'project.read': 'Просмотр проекта',
    'project.manage': 'Управление проектом',
    'package.install': 'Установка инструментов',
};

/** Участники, назначения по проектам и фактические права текущей роли. */
const Access = (): JSX.Element => {
    const { scope: accessScope } = useAuthRequestOwner();
    const dispatch = useAppDispatch();
    const { decisions, loading: decisionsLoading, error: decisionsError } = useSelector((state: RootState) => state.access);
    const currentUser = useSelector((state: RootState) => state.userBlock.user);
    const main = isMainAdminRole(currentUser?.activeRole);
    const [users, setUsers] = useState<IAccessUserRow[] | null>(null);
    const [usersLoading, setUsersLoading] = useState(false);
    const [usersError, setUsersError] = useState('');
    const [search, setSearch] = useState('');
    const [projectFilter, setProjectFilter] = useState<string>();
    const [activeTab, setActiveTab] = useState(main ? 'accounts' : 'projects');
    const [modal, setModal] = useState<{ open: boolean; principalName: string }>({ open: false, principalName: '' });
    const requestRef = useRef(0);

    const loadUsers = useCallback(async (): Promise<void> => {
        const request = ++requestRef.current;
        setUsersLoading(true); setUsersError('');
        try {
            const result = await bffApi.getAccessUsers();
            if (request === requestRef.current) { setUsers(result.users); }
        } catch (error: unknown) {
            if (request === requestRef.current) { setUsersError(errorMessage(error, 'Не удалось загрузить назначения. Проверьте соединение и повторите попытку.')); }
        } finally { if (request === requestRef.current) { setUsersLoading(false); } }
    }, []);

    const refresh = useCallback((): void => { void loadUsers(); void dispatch(fetchDecisions('project')); }, [loadUsers, dispatch]);
    useSectionUpdates(['access', 'projects'], refresh);

    useEffect(() => {
        setUsers(null); setUsersError(''); setModal({ open: false, principalName: '' }); setSearch(''); setProjectFilter(undefined);
    }, [accessScope]);
    useEffect(() => {
        refresh();
        return () => { requestRef.current += 1; };
    }, [accessScope, refresh]);
    useEffect(() => { if (!main && activeTab === 'accounts') { setActiveTab('projects'); } }, [main, activeTab]);

    const allRefs = [...(currentUser?.projectRoles ?? []), ...(users ?? []).flatMap(user => user.accesses)];
    const projectNames = new Map(allRefs.map(ref => [ref.projectId, ref.projectName]));
    const filtered = (users ?? []).filter(user => (!projectFilter || user.accesses.some(ref => ref.projectId === projectFilter)) && [user.principalName, user.displayName, ...user.accesses.map(ref => ref.projectName)].join(' ').toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')));
    const userColumns: ColumnsType<IAccessUserRow> = [
        { title: 'Пользователь', key: 'user', width: 240, render: (_, user) => <Space direction="vertical" size={2}><Typography.Text strong>{user.displayName || user.principalName}</Typography.Text>{user.displayName !== user.principalName && <Typography.Text type="secondary">{user.principalName}</Typography.Text>}</Space> },
        { title: 'Доступ к проектам', key: 'accesses', render: (_, user) => <Space size={[4, 8]} wrap>{user.accesses.length ? user.accesses.map(ref => <Tag key={ref.projectId} color={ref.role === 'Админ проекта' ? 'purple' : ref.role === 'Разработчик' ? 'blue' : undefined}>{ref.projectName} · {ref.role}</Tag>) : <Typography.Text type="secondary">Проектные роли пока не назначены</Typography.Text>}</Space> },
        { title: 'Действия', key: 'actions', width: 130, render: (_, user) => main || user.accesses.some(ref => projectRoleLevel(currentUser, ref.projectId) >= 3) ? <Button size="small" aria-label={'Настроить доступ ' + user.principalName} onClick={() => setModal({ open: true, principalName: user.principalName })}>Настроить</Button> : <Typography.Text type="secondary">Только просмотр</Typography.Text> },
    ];
    const decisionColumns: ColumnsType<IAccessDecision> = [
        { title: 'Область доступа', key: 'scope', render: (_, decision) => <Space direction="vertical" size={2}><Typography.Text strong>{decision.scope === 'platform' ? 'Вся система' : projectNames.get(decision.scopeId) ?? decision.scopeId}</Typography.Text><Typography.Text type="secondary">{decision.scope === 'platform' ? 'Системные полномочия' : 'Проект'}</Typography.Text></Space> },
        { title: 'Доступные действия', dataIndex: 'actions', key: 'actions', render: (actions: string[]) => <Space size={[4, 8]} wrap>{actions.map(action => <Tag key={action}>{ACTION_LABELS[action] ?? action}</Tag>)}</Space> },
    ];

    return <div className="access-page">
        <PageHeading title="Участники и доступ" description="Добавляйте сотрудников по почте и назначайте роли в нужных проектах." />
        <Collapse className="access-page__role-guide" ghost>
            <Collapse.Panel header="Что разрешено каждой роли" key="roles"><div className="access-page__role-grid">
                <div><Typography.Text strong>Наблюдатель</Typography.Text><Typography.Paragraph type="secondary">Просматривает проект и его каталог инструментов.</Typography.Paragraph></div>
                <div><Typography.Text strong>Разработчик</Typography.Text><Typography.Paragraph type="secondary">Устанавливает и использует инструменты своего проекта.</Typography.Paragraph></div>
                <div><Typography.Text strong>Админ проекта</Typography.Text><Typography.Paragraph type="secondary">Управляет каталогом и участниками своего проекта, выбирает инструменты из общего магазина.</Typography.Paragraph></div>
                <div><Typography.Text strong>Главный админ</Typography.Text><Typography.Paragraph type="secondary">Управляет пользователями, общим магазином и всеми проектами.</Typography.Paragraph></div>
            </div></Collapse.Panel>
        </Collapse>
        <Card>
            <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
                ...(main ? [{ key: 'accounts', label: 'Пользователи', children: <PlatformUsers /> }] : []),
                { key: 'projects', label: 'Доступ к проектам', children: <Space direction="vertical" size={20} style={{ width: '100%' }}>
                    <Alert type="info" showIcon message={main ? 'Назначьте сотруднику отдельную роль для каждого проекта.' : 'Вы управляете назначениями внутри своих проектов.'} description="Роль при входе ограничена назначениями пользователя. Главный админ имеет доступ ко всем проектам системы." />
                    {usersError && <Alert type="error" showIcon role="alert" message="Назначения не обновлены" description={usersError} action={<Button loading={usersLoading} onClick={() => void loadUsers()}>Повторить</Button>} />}
                    <div className="access-page__toolbar"><Input.Search value={search} onChange={event => setSearch(event.target.value)} placeholder="Почта, имя или проект" aria-label="Найти участника проекта" allowClear /><Space wrap><Button loading={usersLoading} onClick={() => void loadUsers()}>Обновить</Button><Button type="primary" disabled={!users || usersLoading || Boolean(usersError)} onClick={() => setModal({ open: true, principalName: '' })}>Выдать доступ</Button></Space></div>
                    {projectNames.size > 1 && <Select aria-label="Показать участников проекта" placeholder="Все проекты" value={projectFilter} onChange={setProjectFilter} allowClear className="access-page__project-filter" options={[...projectNames].map(([value, label]) => ({ value, label }))} />}
                    <Table<IAccessUserRow> rowKey="principalName" loading={usersLoading || users === null && !usersError} dataSource={filtered} columns={userColumns} scroll={{ x: 680 }} pagination={{ pageSize: 20, hideOnSinglePage: true, showTotal: total => 'Участников: ' + total }} locale={{ emptyText: usersError ? 'Повторите загрузку назначений' : search.trim() || projectFilter ? 'Участники по выбранным условиям не найдены' : 'Проектные роли пока не назначены. Выдайте доступ сотруднику по почте.' }} />
                </Space> },
                { key: 'decisions', label: 'Мои права', children: <Space direction="vertical" size={20} style={{ width: '100%' }}>
                    <div className="access-page__toolbar"><div><Typography.Text strong>Активная роль: </Typography.Text><Tag color="cyan">{currentUser?.activeRole}</Tag></div><Button loading={decisionsLoading} onClick={() => void dispatch(fetchDecisions('project'))}>Обновить права</Button></div>
                    <Alert type="info" showIcon message="Права проверяются на сервере при каждом запросе." description="Если назначение отозвано, следующий запрос будет проверен заново. Для смены активной роли используйте переключатель в шапке." />
                    {decisionsError && <Alert type="error" showIcon role="alert" message="Не удалось получить актуальные права" description={decisionsError} action={<Button onClick={() => void dispatch(fetchDecisions('project'))}>Повторить</Button>} />}
                    <Table<IAccessDecision> rowKey="decisionId" loading={decisionsLoading} dataSource={decisions} columns={decisionColumns} scroll={{ x: 540 }} pagination={{ pageSize: 20, hideOnSinglePage: true }} locale={{ emptyText: decisionsError ? 'Повторите запрос прав' : 'У текущей роли нет доступных проектов' }} expandable={{ expandedRowRender: decision => <Space direction="vertical" size={4}><Typography.Text type="secondary">Решение: <Typography.Text code>{decision.decisionId}</Typography.Text></Typography.Text><Typography.Text type="secondary">Ревизия политики: {decision.policyRevision}</Typography.Text></Space> }} />
                </Space> },
            ]} />
        </Card>
        <AccessGrantModal key={accessScope} open={modal.open} principalName={modal.principalName} onClose={() => setModal(previous => ({ ...previous, open: false }))} onSaved={(email, complete) => { void loadUsers(); if (complete && email === currentUser?.email?.toLowerCase()) { void dispatch(authInit()); } }} />
    </div>;
};

export default Access;
