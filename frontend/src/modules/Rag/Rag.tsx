import { PageHeading } from '../../common/components/PageHeading';
import { DownloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { Link, useHistory } from 'react-router-dom';
import bffApi from '../../core/api/bff';
import { formatDate } from '../../common/utils/format';
import type { IRagProjectSummary } from '../../core/api/interfaces';
import { useAppDispatch } from '../../core/hooks';
import { RootState } from '../../store';

import { fetchRag } from './redux/actions';
import { clearRag } from './redux/reducers';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {RagSyncStatus} from './RagSyncStatus';

const { Text } = Typography;

/**
 * Экран «RAG / develop-индекс».
 * Показывает develop-индексы (PG + pgvector) по projectKey: количество чанков,
 * размерность, время последней синхронизации.
 *
 * @component
 * @returns JSX-элемент таблицы develop-индексов
 */
const Rag: FC = () => {
    const dispatch = useAppDispatch();
    const history = useHistory();
    const { list, loading, listError, authScope } = useSelector((state: RootState) => state.rag);
    const projects = useSelector((state: RootState) => state.projects);
    const user = useSelector((state: RootState) => state.userBlock.user);
    const [projectNames, setProjectNames] = useState<Record<string, string>>({});
    const nameRequests = useRef(new Map<string, Promise<string | undefined>>());
    const knownNames = useMemo(() => Object.fromEntries([
        ...(user?.projectRoles ?? []).map(project => [project.projectId, project.projectName]),
        ...projects.list.map(project => [project.id, project.name]),
        ...(projects.selected ? [[projects.selected.id, projects.selected.name]] : []),
    ]), [projects.list, projects.selected, user?.projectRoles]);

    const load = useCallback(() => {
        dispatch(fetchRag());
    }, [ dispatch ]);
    useSectionUpdates(['knowledge', 'projects'],load);


    useEffect(() => {
        load();
        return () => { dispatch(clearRag()); };
    }, [ dispatch, load, authScope ]);

    useEffect(() => {
        nameRequests.current.clear();
        setProjectNames({});
    }, [authScope]);

    useEffect(() => {
        let cancelled = false;
        // Сводка знаний содержит ключи: неизвестные имена читаем один раз за открытие страницы.
        const unresolved = [...new Set(list.map(project => project.projectKey))].filter(key => !knownNames[key]);
        void Promise.all(unresolved.map(async projectKey => {
            let request = nameRequests.current.get(projectKey);
            if (!request) {
                request = bffApi.getProject(projectKey).then(project => project.name).catch(() => undefined);
                nameRequests.current.set(projectKey, request);
            }
            return [projectKey, await request] as const;
        })).then(results => {
            if (!cancelled) {
                setProjectNames(Object.fromEntries(results.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))));
            }
        });
        return () => { cancelled = true; };
    }, [list, knownNames, authScope]);

    const columns: ColumnsType<IRagProjectSummary> = [
        {
            title: 'Проект', dataIndex: 'projectKey', key: 'projectKey',
            render: (projectKey: string) => <Link to={`/projects/${encodeURIComponent(projectKey)}`}>{knownNames[projectKey] || projectNames[projectKey] || projectKey}</Link>,
        },
        { title: 'Фрагментов', dataIndex: 'rowCount', key: 'rowCount' },
        { title: 'Размерность', dataIndex: 'dimension', key: 'dimension' },
        {
            title: 'Синхронизация',
            dataIndex: 'lastSyncedAt',
            key: 'lastSyncedAt',
            render: (value: string | null) => (value ? formatDate(value) : <Text type="secondary">нет</Text>),
        },
        {
            title: 'Статус',
            key: 'status',
            width: 80,
            render: (_: unknown, record: IRagProjectSummary) =>
                <RagSyncStatus hasFragments={record.rowCount>0}/>,
        },
        {
            title: 'Действие',
            key: 'restore',
            render: (_: unknown, record: IRagProjectSummary) => (
                <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    title="Открыть базу знаний проекта и параметры синхронизации"
                    onClick={() => history.push(`/projects/${encodeURIComponent(record.projectKey)}?tab=rag`)}
                >
                    Перейти к знаниям
                </Button>
            ),
        },
    ];

    return (
        <div><PageHeading title="Базы знаний" description="Серверные копии знаний о проектах. Скачивайте их в рабочее окружение, чтобы помощник быстрее находил нужный код." />
        <Card
            
            extra={<Button onClick={() => { nameRequests.current.clear(); load(); }} loading={loading}>Обновить</Button>}
        >
            {listError && <Alert type={list.length ? 'warning' : 'error'} showIcon style={{ marginBottom: 16 }}
                message={list.length ? 'Не удалось обновить базы знаний — показаны предыдущие данные' : 'Не удалось загрузить базы знаний'}
                description={<>
                    <Typography.Paragraph>{listError.message}</Typography.Paragraph>
                    <Button size="small" loading={loading} onClick={load}>Повторить</Button>
                </>} />}
            <Table
                rowKey="projectKey"
                loading={loading}
                dataSource={list}
                columns={columns}
                scroll={{ x: 800 }}
                locale={{ emptyText: listError ? 'Список баз знаний не загружен' : <Empty description="Баз знаний пока нет. Откройте проект и отправьте его локальный индекс на сервер."><Button onClick={() => history.push('/projects')}>Перейти к проектам</Button></Empty> }}
                pagination={false}
            />

        </Card></div>
    );
};

export default Rag;
