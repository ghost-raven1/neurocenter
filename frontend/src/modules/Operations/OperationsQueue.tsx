import {roleName} from '../../features/SystemRoles/types';
import {rolePhaseLabel} from '../../features/SystemRoles/RoleRunContent';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Grid, List, Pagination, Select, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useId, useRef } from 'react';
import type { FC } from 'react';
import { useSelector } from 'react-redux';

import type { IOperation, TOperationState } from '../../core/api/interfaces';
import type { RootState } from '../../store';
import AccessibleDrawer from '../../common/components/AccessibleDrawer';

import OperationActionButtons from './OperationActionButtons';
import OperationDetail from './OperationDetail';
import OperationProgress from './OperationProgress';
import { formatOperationTime, operationResourceLabel, operationStateOptions, operationTypeLabel, shortOperationId } from './operationPresentation';
import { useOperationActions } from './useOperationActions';
import { useOperationsQueue } from './useOperationsQueue';

import './Operations.less';

const { Text } = Typography;

interface IOperationsQueueProps {
    /** Не задан — все доступные проекты; задан — только выбранный проект. */
    projectId?: string;
}

/** Общая и проектная очередь с независимыми фильтром, страницей и открытой операцией. */
const OperationsQueue: FC<IOperationsQueueProps> = ({ projectId }) => {
    const queue = useOperationsQueue(projectId);
    const user = useSelector((state: RootState) => state.userBlock.user);
    const screens = Grid.useBreakpoint();
    const filterId = useId();
    const detailTrigger = useRef<HTMLElement | null>(null);
    const restoreDetailFocus = useRef(false);
    const restoreTriggerFocus = (): void => {
        if (detailTrigger.current?.isConnected) { detailTrigger.current.focus({ preventScroll: true }); }
    };
    const closeDetail = (): void => {
        restoreDetailFocus.current = true;
        queue.close();
        queueMicrotask(restoreTriggerFocus);
    };
    const refreshAfterAction = useCallback(async (): Promise<void> => {
        await Promise.all([queue.reload(), queue.refreshDetail()]);
    }, [queue.reload, queue.refreshDetail]);
    const actions = useOperationActions({ reload: refreshAfterAction, enabled: !queue.accessDenied });

    const renderIdentity = (operation: IOperation): JSX.Element => <div className="operations-queue__identity">
        <Text strong>{operation.systemRole ? roleName(operation.systemRole.agentId) : operationTypeLabel(operation.type)}</Text>
        <Text type="secondary">{operation.systemRole ? rolePhaseLabel(operation.systemRole.phase) : operationResourceLabel(operation.resourceType)}</Text>
        <Text className="operations-queue__resource" title={operation.resourceId}>{shortOperationId(operation.resourceId)}</Text>
    </div>;
    const renderActor = (operation: IOperation): JSX.Element => <div className="operations-queue__actor">
        <Text>{operation.actor || '—'}</Text>
        <Text type="secondary">{operation.finishedAt ? 'Завершено' : operation.startedAt ? 'Начато' : 'Начало не зафиксировано'}</Text>
        {(operation.finishedAt || operation.startedAt) && <time dateTime={operation.finishedAt || operation.startedAt || undefined}>
            {formatOperationTime(operation.finishedAt || operation.startedAt)}
        </time>}
    </div>;
    const renderActions = (operation: IOperation): JSX.Element => <OperationActionButtons
        operation={operation}
        user={user}
        actions={actions}
        onDetails={() => {
            // Запоминаем кнопку до автофокуса Drawer, включая быстрое закрытие Escape.
            detailTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            restoreDetailFocus.current = false;
            void queue.select(operation.operationId);
        }}
    />;
    const empty = <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={queue.error ? 'Нет загруженных операций' : queue.state
            ? 'Операций с этим статусом пока нет' : projectId ? 'В этом проекте пока нет операций' : 'Операций пока нет'}
    >
        {queue.state ? <Button onClick={() => { void queue.setState(); }}>Показать все операции</Button>
            : !queue.error && <Text type="secondary">Новые операции появятся здесь автоматически.</Text>}
    </Empty>;
    const columns: ColumnsType<IOperation> = [
        { title: 'Операция', key: 'operation', width: '29%', render: (_, operation) => renderIdentity(operation) },
        { title: 'Состояние', key: 'state', width: '24%', render: (_, operation) => <OperationProgress operation={operation} /> },
        { title: 'Исполнитель и время', key: 'actor', width: '25%', render: (_, operation) => renderActor(operation) },
        { title: 'Действия', key: 'actions', width: '22%', render: (_, operation) => renderActions(operation) },
    ];

    return <div className="operations-queue">
        <div className="operations-queue__heading">
            <Text strong>{projectId ? 'Операции проекта' : 'Все доступные операции'}</Text>
            <Text type="secondary">{queue.state ? 'Найдено: ' : 'Всего: '}<b>{queue.total}</b></Text>
        </div>
        <div className="operations-queue__toolbar">
            <div className="operations-queue__filter">
                <label htmlFor={filterId}>Статус</label>
                <Select<TOperationState | ''>
                    id={filterId}
                    value={queue.state || ''}
                    options={[{ value: '', label: 'Все статусы' }, ...operationStateOptions]}
                    onChange={value => { void queue.setState(value || undefined); }}
                    dropdownMatchSelectWidth={false}
                />
            </div>
            <div className="operations-queue__refresh">
                {queue.updatedAt && <Text type="secondary">Обновлено в {formatOperationTime(queue.updatedAt, true)}</Text>}
                <Button icon={<ReloadOutlined />} loading={queue.loading} onClick={() => { void queue.reload(); }}>Обновить</Button>
            </div>
        </div>
        {queue.error && <Alert
            type="error"
            showIcon
            message="Не удалось обновить операции"
            description={queue.error}
            action={<Button size="small" onClick={() => { void queue.reload(); }}>Повторить</Button>}
        />}
        {screens.sm ? <Table
            className="operations-queue__table"
            rowKey="operationId"
            loading={queue.loading}
            dataSource={queue.list}
            columns={columns}
            tableLayout="fixed"
            size="middle"
            locale={{ emptyText: empty }}
            pagination={{ current: queue.page, pageSize: queue.size, total: queue.total, onChange: queue.setPage, showSizeChanger: false, hideOnSinglePage: true }}
        /> : <>
            <List
                className="operations-queue__cards"
                loading={queue.loading}
                dataSource={queue.list}
                split={false}
                locale={{ emptyText: empty }}
                renderItem={operation => <List.Item>
                    <article className="operations-queue__card">
                        {renderIdentity(operation)}
                        <OperationProgress operation={operation} />
                        {renderActor(operation)}
                        {renderActions(operation)}
                    </article>
                </List.Item>}
            />
            <Pagination
                className="operations-queue__pagination"
                current={queue.page}
                pageSize={queue.size}
                total={queue.total}
                onChange={queue.setPage}
                showSizeChanger={false}
                hideOnSinglePage
                simple
            />
        </>}
        <AccessibleDrawer title="Подробности операции" open={!!queue.selectedId} onClose={closeDetail} width={screens.sm ? 600 : '100%'} destroyOnClose
            afterOpenChange={open => {
                if (!open && restoreDetailFocus.current) {
                    restoreDetailFocus.current = false;
                    queueMicrotask(restoreTriggerFocus);
                }
            }}>
            <OperationDetail
                operation={queue.selected}
                loading={queue.detailLoading}
                error={queue.detailError}
                refresh={queue.refreshDetail}
                user={user}
                actions={actions}
            />
        </AccessibleDrawer>
    </div>;
};

export default OperationsQueue;
