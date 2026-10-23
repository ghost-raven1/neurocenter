import {SystemRoleOperation} from '../../features/SystemRoles/SystemRoleOperation';
import {roleName} from '../../features/SystemRoles/types';
import {rolePhaseLabel} from '../../features/SystemRoles/RoleRunContent';
import { Alert, Button, Descriptions, Empty, List, Space, Spin, Tag, Typography } from 'antd';
import type { FC } from 'react';

import type { IOperationDetail } from '../../core/api/interfaces';
import type { IUserInfo } from '../../core/interfaces';

import OperationActionButtons from './OperationActionButtons';
import OperationProgress from './OperationProgress';
import { formatOperationTime, operationLogLevel, operationResourceLabel, operationTransfer, operationTypeLabel } from './operationPresentation';
import type { useOperationActions } from './useOperationActions';

const { Text, Title } = Typography;

interface IOperationDetailProps {
    operation: IOperationDetail | null;
    loading: boolean;
    error: string;
    refresh: () => Promise<void>;
    user: IUserInfo | null;
    actions: ReturnType<typeof useOperationActions>;
}

/** Полные идентификаторы и доступные сообщения операции без обещания полной истории MCP. */
const OperationDetail: FC<IOperationDetailProps> = ({ operation, loading, error, refresh, user, actions }) => (
    <div className="operation-detail">
        <div className="operation-detail__toolbar">
            <Text type="secondary">Состояние и сообщения</Text>
            <Button size="small" loading={loading} onClick={() => { void refresh(); }}>Обновить</Button>
        </div>
        {error && <Alert type="error" showIcon message="Не удалось обновить подробности" description={error} />}
        {!operation && loading && <div className="operation-detail__loading"><Spin /></div>}
        {operation && <>
            <div className="operation-detail__summary">
                <Title level={5}>{operation.systemRole ? roleName(operation.systemRole.agentId) : operationTypeLabel(operation.type)}</Title>
                <OperationProgress operation={operation} />
                {operation.systemRole && <><Tag>{rolePhaseLabel(operation.systemRole.phase)}</Tag><SystemRoleOperation agentId={operation.systemRole.agentId} runId={operation.systemRole.runId} /></>}
                <OperationActionButtons operation={operation} user={user} actions={actions} />
            </div>
            {operation.error && <Alert className="operation-detail__failure" type="error" showIcon message="Причина ошибки" description={operation.error} />}
            <Descriptions column={1} size="small" className="operation-detail__properties">
                <Descriptions.Item label="ID операции"><Text copyable>{operation.operationId}</Text></Descriptions.Item>
                <Descriptions.Item label="Ресурс">{operationResourceLabel(operation.resourceType)}</Descriptions.Item>
                <Descriptions.Item label="ID ресурса"><Text copyable>{operation.resourceId}</Text></Descriptions.Item>
                <Descriptions.Item label="Проект">{operation.projectId ? <Text copyable>{operation.projectId}</Text> : 'Общая операция'}</Descriptions.Item>
                <Descriptions.Item label="Исполнитель">{operation.actor || '—'}</Descriptions.Item>
                <Descriptions.Item label="Начало">{formatOperationTime(operation.startedAt)}</Descriptions.Item>
                <Descriptions.Item label="Завершение">{formatOperationTime(operation.finishedAt)}</Descriptions.Item>
                <Descriptions.Item label="Передано">{operationTransfer(operation) || 'Нет данных о передаче'}</Descriptions.Item>
            </Descriptions>
            <div className="operation-detail__log-heading">
                <Title level={5}>{operation.resourceType === 'bridge' ? 'Последние сообщения' : 'Журнал'}</Title>
                {operation.retries > 0 && <Text type="secondary">Повторных попыток: {operation.retries}</Text>}
            </div>
            {operation.resourceType === 'bridge' && <Text type="secondary" className="operation-detail__log-note">Доступно последнее сообщение задания моста.</Text>}
            <List
                className="operation-detail__log"
                dataSource={operation.log}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сообщений пока нет" /> }}
                renderItem={item => {
                    const level = operationLogLevel(item.level);
                    return <List.Item>
                        <Space size={8} wrap><time dateTime={item.at}>{formatOperationTime(item.at)}</time><Tag color={level.color}>{level.label}</Tag></Space>
                        <div className="operation-detail__log-message">{item.message}</div>
                    </List.Item>;
                }}
            />
        </>}
    </div>
);

export default OperationDetail;
