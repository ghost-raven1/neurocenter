import { useFeatureAvailability } from '../../features/FeatureFlags/FeatureAvailability';
import CreateProjectModal from './components/CreateProjectModal';
import { PageHeading } from '../../common/components/PageHeading';
import { Alert, Button, Card, Input, message, Popconfirm, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FC, useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { useAppDispatch } from '../../core/hooks';
import { useHistory, useLocation } from 'react-router-dom';

import bffApi from '../../core/api/bff';
import { LocalProjectsFolder } from './local/LocalProjectsFolder';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import { projectRoleLevel } from '../../features/UserBlock/roles';

import AsyncButton from '../../common/components/AsyncButton';
import Permission from '../../common/components/Permission';
import StatusTag from '../../common/components/StatusTag';
import type { IProjectSummary, TProjectState } from '../../core/api/interfaces';
import { baseRoutes } from '../../core/baseRoutes';
import { projectCreateKey, projectsPolitics } from '../../features/UserBlock/permissions';
import { RootState } from '../../store';

import { fetchProject, fetchProjects } from './redux/actions';
import { clearSelected, setPage, setQuery } from './redux/reducers';
import { ProjectSize } from './features/ProjectSize/ProjectSize';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { projectBindingSearch, projectBindingTarget } from './projectNavigation';



/**
 * Экран «Каталог проектов»: список, поиск, создание проекта.
 *
 * @component
 * @returns JSX-элемент списка проектов
 */
const Projects: FC = () => {
    const creation = useFeatureAvailability('projects');
    const dispatch = useAppDispatch();
    const history = useHistory();
    const location = useLocation();
    const { captureOwner } = useAuthRequestOwner();

    const { list, page, size, total, query, loading, listError, authScope, selected, selectedId, selectedLoading, selectedError } = useSelector((state: RootState) => state.projects);

    const [ isCreateOpen, setIsCreateOpen ] = useState<boolean>(false);
    const user = useSelector((state:RootState)=>state.userBlock.user);
    const [localBindings,setLocalBindings]=useState<Record<string,{folderName:string}>>({});
    const bindingId = projectBindingTarget(location.search);
    const bindingRequested = new URLSearchParams(location.search).has('bind');
    const bindingProject = bindingId && !selectedLoading && !selectedError && selectedId === bindingId && selected?.id === bindingId ? selected : null;
    const bindingError = bindingRequested && !bindingId ? 'Ссылка содержит некорректный идентификатор проекта.'
        : selectedId === bindingId ? selectedError?.message : undefined;
    const [ removedIds, setRemovedIds ] = useState<string[]>([]);

    useEffect(() => { setIsCreateOpen(false); }, [authScope]);

    useEffect(() => {
        if (!bindingId) { return; }
        void dispatch(fetchProject(bindingId));
        return () => { dispatch(clearSelected()); };
    }, [dispatch, bindingId, authScope]);

    const openBinding = (id: string): void => {
        history.replace(`${location.pathname}${projectBindingSearch(location.search, id)}${location.hash}`);
    };
    const closeBinding = (): void => {
        dispatch(clearSelected());
        history.replace(`${location.pathname}${projectBindingSearch(location.search, null)}${location.hash}`);
    };

    useEffect(() => {
        dispatch(fetchProjects({ page, size, query }));
    }, [ dispatch, page, size, query, authScope ]);
    useSectionUpdates(['projects'],()=>{void dispatch(fetchProjects({page,size,query}));});

    const retrySizes = (): void => {
        if (captureOwner()()) { void dispatch(fetchProjects({ page, size, query })); }
    };

    /**
     * Удалить проект из каталога.
     *
     * @param {IProjectSummary} record - строка проекта.
     * @returns {Promise<void>}
     */
    const handleDelete = useCallback(async (record: IProjectSummary): Promise<void> => {
        setRemovedIds((prev) => (prev.includes(record.id) ? prev : [ ...prev, record.id ]));

        try {
            await bffApi.deleteProject(record.id);
            message.success(`Проект «${record.name}» удалён`);
            dispatch(fetchProjects({ page, size, query }));
        } catch {
            setRemovedIds((prev) => prev.filter((id) => id !== record.id));
            message.error('Не удалось удалить проект');
        }
    }, [ dispatch, page, size, query ]);

    const openProject = useCallback(
        (record: IProjectSummary): void => {
            history.push(baseRoutes.projectDetail.replace(':projectId', record.id));
        },
        [ history ],
    );

    const columns: ColumnsType<IProjectSummary> = [
        {
            title: 'Имя',
            dataIndex: 'name',
            key: 'name',
            width: 160,
            render: (name: string, record: IProjectSummary) => (
                <a href={baseRoutes.projectDetail.replace(':projectId',record.id)} onClick={event=>{event.stopPropagation();if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();openProject(record);}}}>{name}</a>
            ),
        },
        { title: 'Папка на выбранном компьютере', key: 'localFolder', width: 220, render: (_:unknown,record:IProjectSummary)=><div className={`project-folder${localBindings[record.id]?'':' project-folder_unbound'}`}><span>{localBindings[record.id]?.folderName ?? 'Не связана'}</span>{projectRoleLevel(user,record.id)>=2&&<Button type="link" size="small" aria-label={`${localBindings[record.id]?'Изменить привязку':'Связать папку'} проекта ${record.name}`} onClick={event=>{event.stopPropagation();openBinding(record.id);}}>{localBindings[record.id]?'Изменить':'Связать'}</Button>}</div> },
        { title: 'Состояние', dataIndex: 'state', key: 'state', width: 120, render: (value: TProjectState) => <StatusTag status={value} /> },
        { title: 'Текущие данные', dataIndex: 'logicalBytes', key: 'bytes', width: 150, render: (value: unknown, record) => <ProjectSize kind="logical" bytes={value} error={record.logicalSizeError} loading={loading} onRetry={retrySizes} /> },
        { title: 'Копия знаний', dataIndex: 'retainedBytes', key: 'retained', width: 150, render: (value: unknown, record) => <ProjectSize kind="retained" bytes={value} error={record.retainedSizeError} loading={loading} onRetry={retrySizes} /> },
        { title: 'В работе', dataIndex: 'activeOperations', key: 'ops', width: 85 },
        {
            title: 'Действия',
            key: 'actions',
            width: 100,
            render: (_: unknown, record: IProjectSummary) => (
                projectRoleLevel(user,record.id)>=3 ? <Popconfirm
                    title={`Удалить проект «${record.name}» из каталога?`}
                    okText="Удалить"
                    cancelText="Отмена"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => { void handleDelete(record); }}
                >
                    <Button size="small" danger onClick={(e) => e.stopPropagation()}>
                        Удалить
                    </Button>
                </Popconfirm> : null
            ),
        },
    ];

    return (
        <div><PageHeading title="Проекты" description="Подключайте проекты команды, добавляйте инструменты и управляйте базами знаний." />
        <LocalProjectsFolder project={bindingProject} canManage={!!bindingProject&&projectRoleLevel(user,bindingProject.id)>=2} onClose={closeBinding} onBindings={setLocalBindings}/>
        {bindingRequested && !bindingProject && <Alert showIcon style={{marginBottom:16}} type={bindingError?'error':'info'}
            message={bindingError?'Не удалось открыть привязку проекта':'Загружаем проект для привязки…'} description={bindingError}
            action={<Space>{bindingId && <Button loading={selectedLoading} onClick={()=>void dispatch(fetchProject(bindingId))}>Повторить</Button>}<Button onClick={closeBinding}>Закрыть</Button></Space>} />}
        <Card
            
            extra={
                <Space>
                    <Permission permissionKey={projectCreateKey} politic={projectsPolitics}>
                        <span title={creation.reason || undefined} aria-label={creation.reason || undefined} tabIndex={creation.enabled ? undefined : 0}><AsyncButton type="primary" disabled={!creation.enabled} onClick={() => { if(creation.enabled) setIsCreateOpen(true); }}>
                            Создать проект
                        </AsyncButton></span>
                    </Permission>
                </Space>
            }
        >
            {listError && <Alert type="error" showIcon style={{ marginBottom: 16 }}
                message={list.length ? 'Не удалось обновить проекты — показаны предыдущие данные' : 'Не удалось загрузить проекты'}
                description={listError.message}
                action={<Button size="small" loading={loading} onClick={() => { void dispatch(fetchProjects({ page, size, query })); }}>Повторить</Button>} />}
            <div style={{ marginBottom: 16, width: '100%', maxWidth: 320 }}>
                <Input.Search
                    allowClear
                    aria-label="Поиск проектов"
                    placeholder="Найти проект…"
                    defaultValue={query}
                    style={{ width: '100%' }}
                    onSearch={value => dispatch(setQuery(value))}
                />
            </div>
            <Table
                rowKey="id"
                loading={loading}
                dataSource={list.filter((p) => !removedIds.includes(p.id))}
                columns={columns}
                scroll={{ x: 985 }}
                locale={{ emptyText: listError ? 'Список проектов недоступен. Повторите загрузку.' : query ? 'Проектов с таким названием нет. Попробуйте другой запрос.' : 'Создайте серверный проект или попросите администратора добавить вас. Затем свяжите его с локальной папкой.' }}
                onRow={record => ({ onClick: () => openProject(record), style: { cursor: 'pointer' } })}
                pagination={{
                    current: page,
                    pageSize: size,
                    total,
                    onChange: value => dispatch(setPage(value)),
                }}
            />
            <CreateProjectModal key={authScope} open={isCreateOpen} onClose={() => setIsCreateOpen(false)} onCreated={id => { setIsCreateOpen(false); history.push(`/projects/${id}`); }} />
        </Card></div>
    );
};

export default Projects;
