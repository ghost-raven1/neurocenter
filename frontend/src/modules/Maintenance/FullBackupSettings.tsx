import { CloudSyncOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import type { FC } from 'react';
import { useSelector } from 'react-redux';

import type { RootState } from '../../store';

import FullBackupForm from './FullBackupForm';
import { FullBackupRuns, FullBackupStatus } from './FullBackupStatus';
import { useFullBackupSettings } from './useFullBackupSettings';

const AccountBackupSettings: FC = () => {
    const {
        status, revision, loading, saving, loadError, saveError,
        form, refresh, save, useSavedPolicy,
    } = useFullBackupSettings();

    return (
        <Card
            className="maintenance-page__full-backup"
            title={<Space><CloudSyncOutlined /><span>Полные внешние копии</span></Space>}
            extra={<Button loading={loading} disabled={saving} onClick={() => void refresh()}>Обновить состояние</Button>}
        >
            <Typography.Paragraph className="maintenance-page__intro">
                Согласованный комплект всех серверных баз и файлов создаёт операторский runner. Во время копирования
                приложения приостанавливаются; передача во внешнее хранилище выполняется после их запуска.
            </Typography.Paragraph>
            {loadError && <Alert
                className="maintenance-page__notice" type="error" showIcon
                message="Обслуживание требует внимания" description={loadError}
            />}
            {status && <FullBackupStatus status={status} />}
            {!status && loading && <div className="maintenance-page__loading"><Spin tip="Загружаем настройки…" /></div>}
            <FullBackupForm
                form={form} ready={status !== null} revision={revision} statusRevision={status?.revision ?? null} saving={saving} saveError={saveError}
                onSave={save} onUseSavedPolicy={useSavedPolicy}
            />
            {status && <FullBackupRuns runs={status.runs} />}
        </Card>
    );
};

/** Смена аккаунта или роли создаёт новый черновик и завершает прежние запросы. */
const FullBackupSettings: FC = () => {
    const user = useSelector((state: RootState) => state.userBlock.user);
    if (user?.activeRole !== 'Главный админ') { return null; }
    return <AccountBackupSettings key={`${user.id}:${user.email}:${user.activeRole}`} />;
};

export default FullBackupSettings;
