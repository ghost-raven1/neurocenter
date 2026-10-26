import { ScheduleOutlined, WarningOutlined } from '@ant-design/icons';
import { Badge, Button, Tooltip } from 'antd';
import { useId } from 'react';
import type { FC, Ref } from 'react';

import { useActiveOperations } from './useActiveOperations';
import './OperationsButton.less';

interface IOperationsButtonProps {
    open: boolean;
    onClick: () => void;
    triggerRef?: Ref<HTMLButtonElement>;
}

/** Показывает средний прогресс активных заданий без загрузки полного журнала. */
const OperationsButton: FC<IOperationsButtonProps> = ({ open, onClick, triggerRef }) => {
    const progress = useActiveOperations();
    const descriptionId = useId();
    const active = progress.count > 0;
    const updatedAt = progress.updatedAt
        ? new Date(progress.updatedAt).toLocaleTimeString('ru-RU') : null;
    const description = progress.accessDenied
        ? 'Доступ к операциям отозван. Откройте панель и повторите проверку доступа.'
        : progress.stale
        ? `Не удалось обновить операции. ${updatedAt ? 'Показаны последние полученные данные.' : 'Повторяем проверку.'}`
        : !updatedAt
        ? 'Проверяем активные операции. Открыть историю и подробности.'
        : active
            ? `Активных операций: ${progress.count}. ${progress.running === null
                ? 'Сервер пока не передал общий прогресс.'
                : `Выполняется: ${progress.running}, в очереди: ${progress.queued}. Средний прогресс: ${progress.percent}%.`}`
            : 'Нет активных операций. Открыть историю и подробности.';

    return <>
        <Tooltip placement="bottom" autoAdjustOverflow={false} title={<>{description}{updatedAt && <div>Обновлено: {updatedAt}</div>}</>}>
            <Badge count={progress.count} size="small" className="operations-button-badge">
                <Button
                    ref={triggerRef}
                    className={`operations-button${active ? ' operations-button--active' : ''}${progress.stale ? ' operations-button--stale' : ''}`}
                    icon={progress.stale ? <WarningOutlined /> : <ScheduleOutlined />}
                    aria-label="Операции" aria-describedby={descriptionId} aria-expanded={open} onClick={onClick}
                >
                    <span className="app__operations-label">Операции</span>
                    {active && <span className="operations-button__percent">
                        {progress.percent === null ? '…' : `${progress.percent}%`}
                    </span>}
                    {active && <span
                        className={`operations-button__track${progress.percent === null ? ' operations-button__track--unknown' : ''}`}
                        role="progressbar" aria-label="Средний прогресс активных операций"
                        aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined}
                        aria-valuetext={progress.stale ? `Последний известный прогресс: ${progress.percent === null ? 'не получен' : `${progress.percent}%`}` : undefined}
                    >
                        <span style={{ width: progress.percent === null ? '35%' : `${progress.percent}%` }} />
                    </span>}
                </Button>
            </Badge>
        </Tooltip>
        <span id={descriptionId} className="operations-button-status" role="status">{description}</span>
    </>;
};

export default OperationsButton;
