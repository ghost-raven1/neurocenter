import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Input, List, Pagination, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FC, useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { useSelector } from 'react-redux';

import { PageHeading } from '../../common/components/PageHeading';
import AccessibleDrawer from '../../common/components/AccessibleDrawer';
import type { IErrorEvent } from '../../core/api/interfaces';
import { useAppDispatch } from '../../core/hooks';
import { TRootState } from '../../store';

import ErrorDetails from './ErrorDetails';
import { auditLinkForRequestId, describeErrorMessage, describeErrorLevel, formatErrorTime } from './errorPresentation';
import { fetchError } from './redux/actions';
import { setPage } from './redux/reducers';
import './Error.less';

const { Text } = Typography;
const PERIOD_OPTIONS = [
    { label: 'Весь период', value: '' },
    { label: '24 часа', value: '24h' },
    { label: '7 дней', value: '7d' },
];

/**
 * Журнал ошибок (AD-O5, res-obs 6.11): только safe-поля API (AD-O8).
 * Фильтры service/requestId/period — server-side (GET /api/errors), пагинация —
 * как в модуле «Аудит». Переход по requestId — ссылка на историю действий.
 */
const ErrorList: FC = () => {
    const dispatch = useAppDispatch();
    const history = useHistory();
    const { list, page, size, total, loading, error, loadedPage } = useSelector((state: TRootState) => state.errors);
    const [service, setService] = useState('');
    const [requestId, setRequestId] = useState('');
    const [period, setPeriod] = useState('');
    const [selected, setSelected] = useState<IErrorEvent | null>(null);
    const filtersActive = Boolean(service) || Boolean(requestId) || period !== '';
    const currentList = loadedPage === page ? list : [];

    const openAudit = (event: IErrorEvent): void => {
        if (event.requestId) {
            history.push(auditLinkForRequestId(event.requestId));
        }
    };
    const clearFilters = (): void => {
        setService('');
        setRequestId('');
        setPeriod('');
        dispatch(setPage(1));
    };

    useEffect(() => {
        void dispatch(
            fetchError({
                service: service || undefined,
                requestId: requestId || undefined,
                period: period || undefined,
                page,
                size,
            }),
        );
    }, [dispatch, page, size, service, requestId, period]);
    useEffect(() => {
        if (loadedPage === page && page > Math.max(1, Math.ceil(total / size))) {
            dispatch(setPage(Math.max(1, Math.ceil(total / size))));
        }
    }, [dispatch, loadedPage, page, total, size]);

    const levelTag = (level: IErrorEvent['level']): JSX.Element => {
        const { label, color } = describeErrorLevel(level);
        return <Tag color={color}>{label}</Tag>;
    };
    const requestIdCell = (event: IErrorEvent): JSX.Element => {
        if (!event.requestId) {
            return <Text type="secondary">—</Text>;
        }
        return (
            <Typography.Link
                onClick={() => openAudit(event)}
                aria-label={`История действий: ${event.requestId}`}
                title={event.requestId}
            >
                {event.requestId}
            </Typography.Link>
        );
    };
    const columns: ColumnsType<IErrorEvent> = [
        {
            title: 'Дата и время',
            dataIndex: 'ts',
            key: 'ts',
            width: 180,
            render: (value: string) => formatErrorTime(value),
        },
        {
            title: 'Сервис',
            dataIndex: 'service',
            key: 'service',
            width: 160,
            render: (value: string) => <Text strong>{value}</Text>,
        },
        { title: 'Уровень', key: 'level', width: 130, render: (_: unknown, event) => levelTag(event.level) },
        {
            title: 'Сообщение',
            dataIndex: 'message',
            key: 'message',
            render: (value: string) => describeErrorMessage(value),
        },
        { title: 'Request ID', key: 'requestId', width: 230, render: (_: unknown, event) => requestIdCell(event) },
        {
            title: '',
            key: 'details',
            width: 105,
            render: (_: unknown, event) => (
                <Button
                    size="small"
                    onClick={() => setSelected(event)}
                    aria-label={`Подробности: ${describeErrorMessage(event.message)}`}
                >
                    Подробнее
                </Button>
            ),
        },
    ];
    const empty = (
        <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
                error
                    ? 'Журнал ошибок недоступен'
                    : filtersActive
                      ? 'По выбранному фильтру событий нет'
                      : 'Журнал ошибок пока пуст'
            }
        >
            {filtersActive && !error && <Button onClick={clearFilters}>Сбросить фильтры</Button>}
        </Empty>
    );

    return (
        <div className="error-page">
            <PageHeading
                title="Ошибки"
                description="События ошибок сервисов и интерфейса: безопасные поля, без содержимого запросов."
                actions={
                    <Button
                        icon={<ReloadOutlined />}
                        loading={loading}
                        onClick={() =>
                            void dispatch(
                                fetchError({
                                    service: service || undefined,
                                    requestId: requestId || undefined,
                                    period: period || undefined,
                                    page,
                                    size,
                                }),
                            )
                        }
                    >
                        Обновить журнал
                    </Button>
                }
            />
            <Card>
                <p className="error-page__scope">
                    Записи содержат только безопасные поля: классификатор, кадры без значений, идентификатор запроса.
                    Содержимое запросов и ответы не собираются. По Request ID открывается история действий с тем же
                    идентификатором.
                </p>
                <div className="error-page__filters">
                    <Input.Search
                        allowClear
                        aria-label="Фильтр по сервису"
                        placeholder="Сервис (например, rag)"
                        value={service}
                        onChange={(event) => setService(event.target.value)}
                        onSearch={(value) => {
                            setService(value.trim());
                            dispatch(setPage(1));
                        }}
                    />
                    <Input.Search
                        allowClear
                        aria-label="Фильтр по идентификатору запроса"
                        placeholder="Request ID"
                        value={requestId}
                        onChange={(event) => setRequestId(event.target.value)}
                        onSearch={(value) => {
                            setRequestId(value.trim());
                            dispatch(setPage(1));
                        }}
                    />
                    <Select
                        aria-label="Период журнала ошибок"
                        value={period}
                        onChange={(value: string) => {
                            setPeriod(value);
                            dispatch(setPage(1));
                        }}
                        options={PERIOD_OPTIONS}
                    />
                    {filtersActive && <Button onClick={clearFilters}>Сбросить</Button>}
                </div>
                <div className="error-page__summary" aria-live="polite">
                    <Text type="secondary">Фильтры применяются к журналу целиком.</Text>
                    {loadedPage === page && (
                        <Text type="secondary">{`На странице: ${currentList.length} · всего: ${total}`}</Text>
                    )}
                </div>
                {error && (
                    <Alert
                        className="error-page__error"
                        showIcon
                        type="error"
                        message={
                            currentList.length
                                ? 'Не удалось обновить журнал — показаны предыдущие записи'
                                : 'Не удалось загрузить журнал ошибок'
                        }
                        description={error}
                        action={
                            <Button
                                size="small"
                                loading={loading}
                                onClick={() =>
                                    void dispatch(
                                        fetchError({
                                            service: service || undefined,
                                            requestId: requestId || undefined,
                                            period: period || undefined,
                                            page,
                                            size,
                                        }),
                                    )
                                }
                            >
                                Повторить
                            </Button>
                        }
                    />
                )}
                <div className="error-page__desktop">
                    <Table
                        rowKey="id"
                        loading={loading}
                        dataSource={currentList}
                        columns={columns}
                        scroll={{ x: 1050 }}
                        pagination={false}
                        locale={{ emptyText: empty }}
                    />
                </div>
                <div className="error-page__mobile">
                    <List
                        loading={loading}
                        dataSource={currentList}
                        locale={{ emptyText: empty }}
                        renderItem={(event) => (
                            <List.Item key={event.id} className="error-page__event">
                                <div className="error-page__event-header">
                                    <Text type="secondary">{formatErrorTime(event.ts)}</Text>
                                    {levelTag(event.level)}
                                </div>
                                <Text strong>{event.service}</Text>
                                <div>{describeErrorMessage(event.message)}</div>
                                {event.requestId && <Text type="secondary">Request ID: {event.requestId}</Text>}
                                <Space>
                                    {event.requestId && (
                                        <Button size="small" onClick={() => openAudit(event)}>
                                            В историю
                                        </Button>
                                    )}
                                    <Button size="small" onClick={() => setSelected(event)}>
                                        Подробнее
                                    </Button>
                                </Space>
                            </List.Item>
                        )}
                    />
                </div>
                {total > size && (
                    <Pagination
                        className="error-page__pagination"
                        current={page}
                        pageSize={size}
                        total={total}
                        showSizeChanger={false}
                        showLessItems
                        onChange={(value) => dispatch(setPage(value))}
                        disabled={loading}
                        locale={{ prev_page: 'Предыдущая страница', next_page: 'Следующая страница' }}
                    />
                )}
            </Card>
            <AccessibleDrawer
                title="Подробности события"
                open={Boolean(selected)}
                onClose={() => setSelected(null)}
                width="min(560px, 100vw)"
                destroyOnClose
            >
                {selected && <ErrorDetails key={selected.id} event={selected} />}
            </AccessibleDrawer>
        </div>
    );
};

export default ErrorList;
