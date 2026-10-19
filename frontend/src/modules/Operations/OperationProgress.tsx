import { Progress, Typography } from 'antd';
import type { FC } from 'react';

import StatusTag from '../../common/components/StatusTag';
import type { IOperation } from '../../core/api/interfaces';

import { operationProgressPercent, operationTransfer } from './operationPresentation';

/** Единое представление фактического состояния и переданных данных. */
const OperationProgress: FC<{ operation: IOperation }> = ({ operation }) => {
    const percent = operationProgressPercent(operation.percent);
    const transfer = operationTransfer(operation);
    const status = operation.state === 'FAILED' ? 'exception'
        : operation.state === 'SUCCEEDED' ? 'success'
            : operation.state === 'RUNNING' ? 'active' : 'normal';

    return <div className="operation-progress">
        <StatusTag status={operation.state} />
        <div aria-label={`Прогресс операции: ${percent}%`}>
            <Progress percent={percent} size="small" status={status} format={value => `${value ?? 0}%`} />
        </div>
        {transfer && <Typography.Text type="secondary" className="operation-progress__bytes">{transfer}</Typography.Text>}
    </div>;
};

export default OperationProgress;
