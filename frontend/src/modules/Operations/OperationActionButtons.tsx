import { Button, Space, Tooltip, Typography } from 'antd';
import type { FC } from 'react';

import type { IOperation } from '../../core/api/interfaces';
import type { IUserInfo } from '../../core/interfaces';

import { operationActionPermissions } from './operationActions';
import { operationKnowledgeRecovery } from './operationKnowledgeRecovery';
import { operationPackagingRecovery } from './operationPackagingRecovery';
import type { useOperationActions } from './useOperationActions';

interface IOperationActionButtonsProps {
    operation: IOperation;
    user: IUserInfo | null;
    actions: ReturnType<typeof useOperationActions>;
    onDetails?: () => void;
}

/** Одинаковые разрешения и защита от повторного нажатия в списке и подробностях. */
const OperationActionButtons: FC<IOperationActionButtonsProps> = ({ operation, user, actions, onDetails }) => {
    const permissions = operationActionPermissions(operation, user);
    const busy = actions.isBusy(operation.operationId);
    const recovery = permissions.reopenKnowledge ? operationKnowledgeRecovery(operation) : undefined;
    const packaging = operationPackagingRecovery(operation, user);

    return <Space size={8} wrap direction={recovery && !onDetails ? 'vertical' : undefined} className="operation-actions">
        {onDetails && <Button size="small" onClick={onDetails}>Подробнее</Button>}
        {recovery && <Button size="small" href={recovery.href} title={recovery.reason}>Открыть базу знаний</Button>}
        {packaging && <Button size="small" href={packaging}>Открыть упаковщик</Button>}
        {recovery && !onDetails && <Typography.Text type="secondary">{recovery.reason}</Typography.Text>}
        <Tooltip title={!permissions.retry?operation.actions?.retry.reason??'Действие недоступно текущему пользователю.':undefined}><span aria-label={!permissions.retry?operation.actions?.retry.reason:undefined}>
            <Button size="small" disabled={!permissions.retry} loading={busy} onClick={() => actions.retry(operation)}>{operation.actions?.executor==='bridge'?'Повторить через мост':'Повторить'}</Button>
        </span></Tooltip>
        <Tooltip title={!permissions.cancel?operation.actions?.cancel.reason??'Действие недоступно текущему пользователю.':undefined}><span aria-label={!permissions.cancel?operation.actions?.cancel.reason:undefined}>
            <Button size="small" danger disabled={!permissions.cancel} loading={busy} onClick={() => actions.cancel(operation)}>Отменить задание</Button>
        </span></Tooltip>
        {operation.actions&&!operation.actions.retry.supported&&!operation.actions.cancel.supported&&<Typography.Text type="secondary">{operation.actions.retry.reason}</Typography.Text>}
    </Space>;
};

export default OperationActionButtons;
