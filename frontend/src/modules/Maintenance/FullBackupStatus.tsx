import { Alert, List, Space, Tag, Typography } from 'antd';
import type { FC } from 'react';

import { formatBackupTime } from './maintenanceBackup';
import { formatBackupAge, formatScheduledBackup, maintenanceFailure } from './maintenancePolicy';
import type { IMaintenanceRun, IMaintenanceStatus } from './maintenancePolicy';

interface IFullBackupStatusProps {
    status: IMaintenanceStatus;
}

const runLabels: Record<IMaintenanceRun['state'], string> = {
    failed: 'Ошибка', running: 'Выполняется', succeeded: 'Проверена внешняя копия',
};
const runColors: Record<IMaintenanceRun['state'], string> = {
    failed: 'error', running: 'processing', succeeded: 'success',
};

export const FullBackupStatus: FC<IFullBackupStatusProps> = ({ status }) => (
    <>
        <dl className="maintenance-page__status-grid">
            <div>
                <dt>Следующее плановое время</dt>
                <dd>{status.nextRunAt
                    ? `${formatScheduledBackup(status.nextRunAt, status.policy.timeZone)} (${status.policy.timeZone})`
                    : 'Расписание выключено'}</dd>
            </div>
            <div>
                <dt>Возраст проверенной внешней копии</dt>
                <dd><Tag color={status.rpoExceeded ? 'error' : 'success'}>{formatBackupAge(status.externalAgeSeconds)}</Tag></dd>
            </div>
            <div>
                <dt>Внешнее хранилище</dt>
                <dd>{status.external?.storageId || 'Проверка передачи не подтверждена'}</dd>
            </div>
            <div>
                <dt>Проверка чтением SHA</dt>
                <dd>{status.external ? formatBackupTime(status.external.verifiedAt) : 'Нет свидетельств'}</dd>
            </div>
        </dl>
        {status.rpoExceeded && <Alert
            className="maintenance-page__notice" type="warning" showIcon message="Цель RPO пока не выполнена"
            description="Нет проверенной внешней копии или её точка данных старше заданной цели. Локальный дамп каталога не считается внешней копией."
        />}
    </>
);

export const FullBackupRuns: FC<{ runs: IMaintenanceRun[] }> = ({ runs }) => {
    if (!runs.length) { return null; }
    return (
        <List
            className="maintenance-page__runs" size="small" header="Последние запуски полной копии"
            dataSource={runs} renderItem={run => (
                <List.Item>
                    <Space direction="vertical" size={0}>
                        <Space wrap>
                            <Typography.Text>{formatBackupTime(run.startedAt)}</Typography.Text>
                            <Tag color={runColors[run.state]}>{runLabels[run.state]}</Tag>
                        </Space>
                        {run.errorCode && <Typography.Text type="danger">{maintenanceFailure(run.errorCode)}</Typography.Text>}
                    </Space>
                </List.Item>
            )}
        />
    );
};
