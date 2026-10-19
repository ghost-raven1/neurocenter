import { Button, Space } from 'antd';
import type { FC } from 'react';

import type { IOperation } from '../../core/api/interfaces';
import type { IUserInfo } from '../../core/interfaces';

import { operationActionPermissions } from './operationActions';
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

    return <Space size={8} wrap className="operation-actions">
        {onDetails && <Button size="small" onClick={onDetails}>Подробнее</Button>}
        {permissions.retry && <Button size="small" loading={busy} onClick={() => actions.retry(operation)}>Повторить через мост</Button>}
        {permissions.cancel && <Button size="small" danger loading={busy} onClick={() => actions.cancel(operation)}>Отменить задание</Button>}
    </Space>;
};

export default OperationActionButtons;
