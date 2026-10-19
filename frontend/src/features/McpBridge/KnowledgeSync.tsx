import { Alert, Button, Space } from 'antd';
import { useRef, useState, type FC } from 'react';
import { Link } from 'react-router-dom';
import { bridgeApi } from './api';
import { useBridge } from './useBridge';
import { BridgeConnection } from './BridgeConnection';
import { errorMessage } from '../../common/utils/errorMessage';
import { isPending } from './installationHelpers';
import { bridgeOperationBlocker } from './readiness';

/** Синхронизация с локальной LanceDB выполняется привязанным MCP, не процессом сервера. */
export const KnowledgeSync: FC<{
    projectId: string;
    canWrite: boolean;
    connection?: boolean;
}> = ({ projectId, canWrite, connection }) => {
    const bridge = useBridge();
    const bridgeError = bridgeOperationBlocker(bridge.device);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const unsupported = bridge.device?.report.ragSupported === false;
    const binding = bridge.device?.report.bindings?.some(
        (item) => item.projectId === projectId && item.valid !== false,
    );
    const matchingJobs = bridge.jobs.filter(
        (item) =>
            item.deviceId === bridge.device?.id &&
            item.projectId === projectId &&
            ['restore-rag', 'sync-rag'].includes(item.kind),
    );
    const job = matchingJobs.find(isPending) || matchingJobs[0];
    const pending = isPending(job);
    const create = async (kind: 'restore-rag' | 'sync-rag'): Promise<void> => {
        if (!bridge.device || bridgeError || unsupported || !bridge.devicesReady || !bridge.jobsReady || !binding || !canWrite || pending || lock.current) {
            return;
        }
        lock.current = true;
        setBusy(true);
        setError('');
        try {
            await bridgeApi.create({
                deviceId: bridge.device.id,
                projectId,
                kind,
                requestKey: crypto.randomUUID(),
            });
            await bridge.reload();
        } catch (cause) {
            setError(
                errorMessage(cause, 'Не удалось передать синхронизацию мосту.'),
            );
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            {connection && <BridgeConnection bridge={bridge} compact />}
            {unsupported && <Alert type="warning" showIcon message={bridge.device?.report.ragError || 'Локальная LanceDB недоступна на этом компьютере.'} />}
            <Space wrap>
                <Button
                    disabled={!!bridgeError || unsupported || !canWrite || !bridge.devicesReady || !bridge.jobsReady || !binding || pending || busy}
                    title={bridgeError || undefined}
                    loading={busy}
                    onClick={() => {
                        void create('restore-rag');
                    }}
                >
                    Скачать в проект через мост
                </Button>
                <Button
                    disabled={!!bridgeError || unsupported || !canWrite || !bridge.devicesReady || !bridge.jobsReady || !binding || pending || busy}
                    title={bridgeError || undefined}
                    onClick={() => {
                        void create('sync-rag');
                    }}
                >
                    Синхронизировать с сервером
                </Button>
            </Space>
            {bridge.device && bridge.devicesReady && !binding && (
                <span>Папка проекта ещё не связана с мостом. <Link to="/projects">Связать папку проекта</Link></span>
            )}
            {job && (
                <Alert
                    role="status"
                    type={
                        job.state === 'failed'
                            ? 'error'
                            : job.state === 'succeeded'
                              ? 'success'
                              : 'info'
                    }
                    showIcon
                    message={job.message}
                />
            )}
            {error && <Alert role="alert" type="error" message={error} />}
        </Space>
    );
};
