import { Button, Space, Typography } from 'antd';
import type { FC } from 'react';

import type { IOperation } from '../../core/api/interfaces';
import type { IUserInfo } from '../../core/interfaces';

import { operationActionPermissions } from './operationActions';
import { operationKnowledgeRecovery } from './operationKnowledgeRecovery';
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

    return <Space size={8} wrap direction={recovery && !onDetails ? 'vertical' : undefined} className="operation-actions">
        {onDetails && <Button size="small" onClick={onDetails}>Подробнее</Button>}
        {recovery && <Button size="small" href={recovery.href} title={recovery.reason}>Открыть базу знаний</Button>}
        {recovery && !onDetails && <Typography.Text type="secondary">{recovery.reason}</Typography.Text>}
        {permissions.retry && <Button size="small" loading={busy} onClick={() => actions.retry(operation)}>Повторить через мост</Button>}
        {permissions.cancel && <Button size="small" danger loading={busy} onClick={() => actions.cancel(operation)}>Отменить задание</Button>}
    </Space>;
};

export default OperationActionButtons;
