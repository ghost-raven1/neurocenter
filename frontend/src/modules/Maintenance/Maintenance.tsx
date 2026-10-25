import { FeatureButton } from '../../features/FeatureFlags/FeatureAvailability';
import { CloudServerOutlined, DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Descriptions, Empty, List, Progress, Row, Space, Spin, Tag, Typography, message } from 'antd';
import { FC, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { PageHeading } from '../../common/components/PageHeading';
import { errorMessage } from '../../common/utils/errorMessage';
import { formatBytes } from '../../common/utils/format';
import { useAppDispatch } from '../../core/hooks';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { RootState } from '../../store';
import { authDataScope } from '../../features/UserBlock/authDataScope';

import { createCatalogBackup, formatBackupTime, latestBackupTime } from './maintenanceBackup';
import type { ICatalogBackupResult } from './maintenanceBackup';
import { createMaintenanceRequestScope } from './maintenanceRequestScope';
import { fetchBackup, fetchStorage } from './redux/actions';
import CapacityStatus from './CapacityStatus';
import FullBackupSettings from './FullBackupSettings';
import WebRestore from './restore/WebRestore';
import RetiredRagDatabases from '../../features/RetiredRagDatabases/RetiredRagDatabases';
import { FeatureFlagsPanel } from '../../features/FeatureFlags/FeatureFlagsPanel';
import { RagQuotaPolicy } from '../../features/RagQuotaPolicy/RagQuotaPolicy';
import {MaintenanceSections} from './MaintenanceSections';
import './Maintenance.less';

const { Paragraph, Text, Title } = Typography;

/** Состояние служебных БД и независимые сценарии резервного копирования. */
const AccountMaintenance: FC = () => {
    const dispatch = useAppDispatch();
    const restoreAccount = useSelector((state: RootState) => state.userBlock.user?.email ?? '');
    const { storage, backup, storageLoading, backupLoading, storageError, backupError, backupAccessDenied } = useSelector((state: RootState) => state.maintenance);
    const [ backingUp, setBackingUp ] = useState(false);
    const [ createError, setCreateError ] = useState<string | null>(null);
    const [ createdBackup, setCreatedBackup ] = useState<ICatalogBackupResult | null>(null);
    const backupLock = useRef(false);
    const requestScope = useMemo(createMaintenanceRequestScope, []);

    useLayoutEffect(() => {
        requestScope.activate();
        return () => requestScope.dispose();
    }, [requestScope]);

    useEffect(() => {
        if (backupAccessDenied) {
            setCreatedBackup(null);
            setCreateError(null);
        }
    }, [backupAccessDenied]);

    useEffect(() => {
        void dispatch(fetchStorage());
        void dispatch(fetchBackup());
    }, [ dispatch ]);

    const refresh = (): void => {
        void dispatch(fetchStorage());
        void dispatch(fetchBackup());
    };
    useSectionUpdates(['maintenance'], refresh);

    const handleBackup = async (): Promise<void> => {
        if (backupLock.current || backupAccessDenied) { return; }
        const isCurrent = requestScope.captureOwner();
        if (!isCurrent()) { return; }
        backupLock.current = true;
        setBackingUp(true);
        setCreateError(null);
        try {
            const result = await createCatalogBackup();
            if (!isCurrent()) { return; }
            setCreatedBackup(result);
            message.success('Резервная копия системного каталога создана');
            refresh();
        } catch (error) {
            if (isCurrent()) {
                setCreateError(errorMessage(error, 'Не удалось создать резервную копию. Проверьте подключение и повторите попытку.'));
            }
        } finally {
            backupLock.current = false;
            if (isCurrent()) { setBackingUp(false); }
        }
    };

    const lastBackupAt = backupAccessDenied ? null : latestBackupTime(createdBackup?.createdAt, backup?.lastBackupAt);
    const usedPercent = storage && storage.totalBytesLimit > 0
        ? Math.round(storage.totalBytesUsed / storage.totalBytesLimit * 100) : null;

    return (
        <div className="maintenance-page">
            <PageHeading
                title="Обслуживание"
                description="Расписание резервных копий, состояние хранилищ и восстановление серверных данных."
                actions={<Button icon={<ReloadOutlined />} loading={storageLoading || backupLoading} onClick={refresh} disabled={backingUp}>Обновить сведения</Button>}
            />
            <MaintenanceSections backups={<Row gutter={[24, 24]}>
                <Col span={24}><FullBackupSettings /></Col>
                <Col span={24}><WebRestore account={restoreAccount} /></Col>
                <Col xs={24} xl={15}>
                    <Card
                        className="maintenance-page__backup"
                        title={<Space><DatabaseOutlined /><span>Системный каталог</span></Space>}
                        extra={<Tag color={backingUp ? 'processing' : undefined}>{backingUp ? 'Создаётся копия' : 'Ручное копирование'}</Tag>}
                    >
                        <Paragraph>Служебная PostgreSQL-база: проекты, пользователи, права и записи каталога. Файлы скиллов и архивы пакетов хранятся отдельно и в этот дамп не входят.</Paragraph>
                        {backupError && <Alert
                            className="maintenance-page__notice"
                            type="error" showIcon
                            message={backup ? 'Не удалось обновить сведения о копии' : 'Сведения о копии недоступны'}
                            description={backupError}
                            action={<Button size="small" loading={backupLoading} onClick={() => void dispatch(fetchBackup())}>Повторить</Button>}
                        />}
                        <div className="maintenance-page__last-copy" aria-live="polite" aria-busy={backupLoading}>
                            <Text type="secondary">Последнее успешное создание</Text>
                            {backupLoading && !backup && !createdBackup ? <Spin size="small" /> : (
                                <Title level={3}>{lastBackupAt ? formatBackupTime(lastBackupAt) : backupError ? 'Нет сведений' : 'Копий пока нет'}</Title>
                            )}
                            <Text type="secondary">Хранятся пять последних дампов на сервере. Дата создания сама по себе не подтверждает восстановимость файла.</Text>
                        </div>
                        {createError && <Alert className="maintenance-page__notice" type="error" showIcon message="Копия не подтверждена" description={createError} />}
                        {!!createdBackup?.warnings?.length&&<Alert className="maintenance-page__notice" type="warning" showIcon message="Копия создана с предупреждением" description={createdBackup.warnings.join(' ')} />}
                        {backingUp && <Alert className="maintenance-page__notice" type="info" showIcon message="Создаём полный дамп каталога" description="Дождитесь ответа сервера. Результат появится здесь после завершения." />}
                        <FeatureButton features={['project_backups']} type="primary" size="large" loading={backingUp} disabled={backupAccessDenied} onClick={() => void handleBackup()} icon={<DatabaseOutlined />}>
                            {backingUp ? 'Создаём копию…' : createError ? 'Повторить создание копии' : 'Создать копию каталога'}
                        </FeatureButton>
                        {createdBackup && !backupAccessDenied && <div className="maintenance-page__created" aria-live="polite">
                            <Text strong>Файлы последнего запуска · {formatBackupTime(createdBackup.createdAt)}</Text>
                            <List
                                size="small" dataSource={createdBackup.files}
                                renderItem={file => <List.Item key={file.fileName}>
                                    <Text className="maintenance-page__filename" code>{file.fileName}</Text>
                                    <Text className="maintenance-page__file-size" type="secondary">{formatBytes(file.sizeBytes)}</Text>
                                </List.Item>}
                            />
                            <Text type="secondary">Полные дампы PostgreSQL сохранены на сервере. Их список показан для этого запуска.</Text>
                        </div>}
                    </Card>
                </Col>
                <Col xs={24} xl={9}>
                    <Space direction="vertical" size={24} className="maintenance-page__side">
                        <Card title={<Space><CloudServerOutlined /><span>Базы знаний проектов</span></Space>}>
                            <Paragraph>У каждого проекта своя PostgreSQL-база и отдельные резервные копии. Создать и скачать дамп можно на вкладке «Резервные копии» в проекте.</Paragraph>
                            <Paragraph type="secondary">Локальная LanceDB и файлы на компьютере сотрудника в серверную копию не входят.</Paragraph>
                            <Button href="/projects">Открыть проекты</Button>
                        </Card>
                    </Space>
                </Col>
            </Row>} storage={<Row gutter={[24, 24]}>
                <Col span={24}><RagQuotaPolicy /></Col>
                <Col span={24}><RetiredRagDatabases /></Col>
                <Col span={24}><CapacityStatus /></Col>
                <Col span={24}>
                    <Card
                        className="maintenance-page__storage"
                        title="Размер служебных баз"
                        extra={storageLoading && storage ? <Spin size="small" /> : undefined}
                    >
                        {storageError && <Alert
                            className="maintenance-page__notice"
                            type="error" showIcon
                            message={storage ? 'Не удалось обновить размеры — показаны предыдущие данные' : 'Не удалось получить размеры баз'}
                            description={storageError}
                            action={<Button size="small" loading={storageLoading} onClick={() => void dispatch(fetchStorage())}>Повторить</Button>}
                        />}
                        {storageLoading && !storage ? <div className="maintenance-page__loading"><Spin tip="Загружаем размеры…" /></div> : storage ? <>
                            <Row gutter={[ 24, 16 ]}>
                                <Col xs={24} md={16}>
                                    <Descriptions column={{ xs: 1, sm: 2 }} layout="vertical" size="small">
                                        {storage.buckets.map(bucket => <Descriptions.Item
                                            key={bucket.name}
                                            label={bucket.name.startsWith('catalog') ? 'Системный каталог' : bucket.name.startsWith('rag') ? 'Общая база RAG' : bucket.name}
                                        ><Text strong>{formatBytes(bucket.bytesUsed)}</Text></Descriptions.Item>)}
                                    </Descriptions>
                                </Col>
                                <Col xs={24} md={8} className="maintenance-page__storage-total">
                                    <Text type="secondary">Сумма в сводке</Text>
                                    <Title level={3}>{formatBytes(storage.totalBytesUsed)}</Title>
                                    <Text type="secondary">Лимит: {storage.totalBytesLimit > 0 ? formatBytes(storage.totalBytesLimit) : 'не задан'}</Text>
                                    {usedPercent !== null && <Progress
                                        className="maintenance-page__capacity"
                                        percent={Math.min(100, Math.max(0, usedPercent))}
                                        status={usedPercent >= 100 ? 'exception' : 'normal'}
                                        format={() => `${usedPercent}%`}
                                    />}
                                </Col>
                            </Row>
                            <Paragraph type="secondary" className="maintenance-page__scope">Эта сводка включает служебный каталог и прежнюю общую базу RAG. Отдельные базы знаний проектов, файлы и архивы сюда пока не входят. Нулевой размер RAG также может означать, что база недоступна.</Paragraph>
                        </> : !storageError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Размеры пока не получены" /> : null}
                    </Card>
                </Col>
            </Row>} features={<FeatureFlagsPanel />} />
        </div>
    );
};

/** Результат ручного запуска и локальные ошибки принадлежат одному аккаунту и набору прав. */
const Maintenance: FC = () => {
    const { user, policies } = useSelector((state: RootState) => state.userBlock);
    return user?.email ? <AccountMaintenance key={authDataScope({ user, policies })} /> : null;
};

export default Maintenance;
