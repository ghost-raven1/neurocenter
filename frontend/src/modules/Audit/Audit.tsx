import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Drawer, Empty, Input, List, Pagination, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { PageHeading } from '../../common/components/PageHeading';
import StatusTag from '../../common/components/StatusTag';
import type { IAuditEvent } from '../../core/api/interfaces';
import { useAppDispatch } from '../../core/hooks';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { RootState } from '../../store';

import AuditDetails from './AuditDetails';
import { auditActorLabel, auditResourceLabel, describeAuditAction, filterAuditPage, formatAuditTime } from './auditHelpers';
import { startAuditRefresh } from './auditRefresh';
import { fetchAudit } from './redux/actions';
import { setPage } from './redux/reducers';
import './Audit.less';

const { Paragraph, Text } = Typography;
const OUTCOME_OPTIONS = [
    { label: 'Любой результат', value: 'all' },
    { label: 'Успешно', value: 'SUCCEEDED' },
    { label: 'Ошибка', value: 'FAILED' },
    { label: 'Отменено', value: 'CANCELLED' },
    { label: 'Конфликт', value: 'CONFLICT' },
    { label: 'Выполняется', value: 'RUNNING' },
    { label: 'В очереди', value: 'QUEUED' },
];

/** История сохранённых операций без обещания полного аудита всех действий системы. */
const Audit: FC = () => {
    const dispatch = useAppDispatch();
    const { list, page, size, total, loading, error, loadedPage } = useSelector((state: RootState) => state.audit);
    const [ outcome, setOutcome ] = useState('all');
    const [ search, setSearch ] = useState('');
    const [ selected, setSelected ] = useState<IAuditEvent | null>(null);
    const filtersActive = Boolean(search.trim()) || outcome !== 'all';
    const currentList = loadedPage === page ? list : [];
    const filtered = useMemo(() => filterAuditPage(currentList, search, outcome), [ currentList, outcome, search ]);

    const refresh = (): void => { void dispatch(fetchAudit({ page, size })); };
    const latestRefresh = useRef({ refresh, loading });
    latestRefresh.current = { refresh, loading };
    useSectionUpdates(['audit', 'operations'], refresh);
    const clearFilters = (): void => { setSearch(''); setOutcome('all'); };

    useEffect(() => { void dispatch(fetchAudit({ page, size })); }, [ dispatch, page, size ]);
    useEffect(() => startAuditRefresh(() => latestRefresh.current), []);
    useEffect(() => {
        if (loadedPage === page && page > Math.max(1, Math.ceil(total / size))) {
            dispatch(setPage(Math.max(1, Math.ceil(total / size))));
        }
    }, [ dispatch, loadedPage, page, total, size ]);

    const actionTag = (event: IAuditEvent): JSX.Element => {
        const action = describeAuditAction(event.action);
        return <Tag color={action.color}>{action.label}</Tag>;
    };
    const columns: ColumnsType<IAuditEvent> = [
        { title: 'Дата и время', dataIndex: 'at', key: 'at', width: 180, render: (value: string) => formatAuditTime(value) },
        { title: 'Действие', key: 'action', width: 170, render: (_: unknown, event) => actionTag(event) },
        { title: 'Ресурс', key: 'resource', render: (_: unknown, event) => <Space direction="vertical" size={2}><Text type="secondary">{auditResourceLabel(event.resourceType)}</Text><Text>{event.resourceId || 'Не указан'}</Text></Space> },
        { title: 'Исполнитель', dataIndex: 'actor', key: 'actor', width: 190, render: (value: string) => auditActorLabel(value) },
        { title: 'Результат', dataIndex: 'outcome', key: 'outcome', width: 130, render: (value: string) => <StatusTag status={value} /> },
        { title: '', key: 'details', width: 105, render: (_: unknown, event) => <Button size="small" onClick={() => setSelected(event)} aria-label={`Подробности: ${describeAuditAction(event.action).label}, ${event.resourceId || event.id}`}>Подробнее</Button> },
    ];
    const empty = <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={error ? 'История недоступна' : filtersActive ? 'На этой странице нет подходящих записей' : 'Журнал операций пока пуст'}
    >{filtersActive && !error && <Button onClick={clearFilters}>Сбросить фильтры</Button>}</Empty>;

    return <div className="audit-page">
        <PageHeading
            title="История действий"
            description="Операции и зафиксированные изменения инструментов, доступа и обслуживания."
            actions={<Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>Обновить историю</Button>}
        />
        <Card>
            <Paragraph type="secondary" className="audit-page__scope">Операции и изменения инструментов, скиллов, доступа и обслуживания. Для скиллов учитываются редактор, синхронизация и создание папок через API; ручные правки файлов не покрыты. История обновляется автоматически.</Paragraph>
            <div className="audit-page__filters">
                <Input.Search
                    allowClear
                    aria-label="Поиск на текущей странице истории"
                    placeholder="Действие, ресурс, участник или ID"
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    onSearch={setSearch}
                />
                <Select aria-label="Результат операции на текущей странице" value={outcome} onChange={setOutcome} options={OUTCOME_OPTIONS} />
                {filtersActive && <Button onClick={clearFilters}>Сбросить</Button>}
            </div>
            <div className="audit-page__summary" aria-live="polite">
                <Text type="secondary">Фильтры действуют на текущей странице.</Text>
                {loadedPage === page && <Text type="secondary">{filtersActive ? `Найдено ${filtered.length} из ${currentList.length} на странице` : `На странице: ${currentList.length}`} · всего в журнале: {total}</Text>}
            </div>
            {error && <Alert
                className="audit-page__error" showIcon type="error"
                message={currentList.length ? 'Не удалось обновить историю — показаны предыдущие записи' : 'Не удалось загрузить историю'}
                description={error}
                action={<Button size="small" loading={loading} onClick={refresh}>Повторить</Button>}
            />}
            <div className="audit-page__desktop">
                <Table
                    rowKey="id" loading={loading} dataSource={filtered} columns={columns}
                    scroll={{ x: 1020 }} pagination={false} locale={{ emptyText: empty }}
                />
            </div>
            <div className="audit-page__mobile">
                <List
                    loading={loading} dataSource={filtered} locale={{ emptyText: empty }}
                    renderItem={event => <List.Item key={event.id} className="audit-page__event">
                        <div className="audit-page__event-header"><Text type="secondary">{formatAuditTime(event.at)}</Text><StatusTag status={event.outcome} /></div>
                        <div>{actionTag(event)}</div>
                        <Text>{auditResourceLabel(event.resourceType)} · {event.resourceId || 'не указан'}</Text>
                        <Text type="secondary">{auditActorLabel(event.actor)}</Text>
                        <Button size="small" onClick={() => setSelected(event)} aria-label={`Подробности: ${describeAuditAction(event.action).label}, ${event.resourceId || event.id}`}>Подробнее</Button>
                    </List.Item>}
                />
            </div>
            {total > size && <Pagination
                className="audit-page__pagination" current={page} pageSize={size} total={total}
                showSizeChanger={false} showLessItems onChange={value => dispatch(setPage(value))}
                disabled={loading} locale={{ prev_page: 'Предыдущая страница', next_page: 'Следующая страница' }}
            />}
        </Card>
        <Drawer title="Подробности события" open={Boolean(selected)} onClose={() => setSelected(null)} width="min(560px, 100vw)" destroyOnClose>
            {selected && <AuditDetails key={selected.id} event={selected} />}
        </Drawer>
    </div>;
};

export default Audit;
