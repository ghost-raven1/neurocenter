import { Alert, Button, Space, Typography } from 'antd';
import { useEffect, useRef, useState, type FC } from 'react';
import { Link } from 'react-router-dom';
import { bridgeApi } from './api';
import { useBridge } from './useBridge';
import { BridgeConnection } from './BridgeConnection';
import { errorMessage } from '../../common/utils/errorMessage';
import { isPending } from './installationHelpers';
import { bridgeOperationBlocker } from './readiness';
import { currentKnowledgeJobs, knowledgeSyncBlocker } from './knowledgeSyncState';
import { OpenCodeRagUi } from './ragUi/OpenCodeRagUi';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { createBridgeRequestKey } from './bridgeRequestKey';
import { projectBindingUrl } from '../../modules/Projects/projectNavigation';
import type {IRagUiPreference} from './ragUi/ragUiPreference';

/** Синхронизация с локальной LanceDB выполняется привязанным MCP, не процессом сервера. */
export const KnowledgeSync: FC<{
    projectId: string;
    canWrite: boolean;
    connection?: boolean;
    serverReady?: boolean;
    preferred?:IRagUiPreference;
}> = ({ projectId, canWrite, connection, serverReady, preferred }) => {
    const { scope: ownerScope, captureOwner } = useAuthRequestOwner();
    const bridge = useBridge();
    const bridgeError = knowledgeSyncBlocker(bridge.device);
    const restoreError = serverReady === false ? 'Сначала синхронизируйте полный индекс с сервером' : '';
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const binding = bridge.device?.report.bindings?.find(
        (item) => item.projectId === projectId && item.valid !== false && /^[a-f0-9]{64}$/.test(item.bindingId || ''),
    );
    const matchingJobs = currentKnowledgeJobs(bridge.jobs,bridge.device?.id,projectId,binding?.bindingId);
    const job = matchingJobs.find(isPending) || matchingJobs[0];
    const pending = isPending(job);
    const scope = JSON.stringify([ownerScope,projectId,bridge.device?.id,binding?.bindingId,canWrite]);
    const currentScope = useRef(scope); currentScope.current = scope;
    const request = useRef<{scope:string;kind:'restore-rag'|'sync-rag';key:string}>();
    if (request.current?.scope !== scope) { request.current = undefined; }
    const sequence = useRef(0);
    useEffect(() => {
        sequence.current++; lock.current = false; setBusy(false); setError('');
        return () => { sequence.current++; };
    },[scope]);
    const create = async (kind: 'restore-rag' | 'sync-rag'): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || !bridge.device || bridgeError || (kind === 'restore-rag' && restoreError) || !bridge.devicesReady || !bridge.jobsReady || !binding || !canWrite || pending || lock.current) {
            return;
        }
        lock.current = true;
        const ticket = ++sequence.current;
        const current = (): boolean => owns() && ticket === sequence.current && currentScope.current === scope;
        setBusy(true);
        setError('');
        try {
            // Потерянный ответ повторяет исходный POST; смена направления означает новое действие.
            if (request.current?.kind !== kind) { request.current = undefined; }
            const saved = request.current ?? {scope,kind,key:createBridgeRequestKey()};
            request.current = saved;
            await bridgeApi.create({
                deviceId: bridge.device.id,
                projectId,
                kind,
                expectedBindingId: binding.bindingId,
                requestKey: saved.key,
            });
            if (current()) {
                if (request.current === saved) { request.current = undefined; }
                void bridge.reload().catch(() => {
                    if (current()) { setError('Задание принято, но не удалось обновить его состояние. Обновите данные.'); }
                });
            }
        } catch (cause) {
            if (current()) { setError(
                errorMessage(cause, 'Не удалось передать синхронизацию мосту.'),
            ); }
        } finally {
            if (current()) { lock.current = false; setBusy(false); }
        }
    };
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            {connection && <BridgeConnection bridge={bridge} compact />}
            {binding && <Typography.Text type="secondary">Папка проекта: <Typography.Text code>{binding.folderName}</Typography.Text></Typography.Text>}
            <OpenCodeRagUi bridge={bridge} projectId={projectId} canWrite={canWrite} preferred={preferred} />
            {bridge.device && bridgeError && !bridgeOperationBlocker(bridge.device) && <Alert type="warning" showIcon message={bridgeError}
                action={!bridge.device.report.capabilities?.includes('project-rag-sync-v1') ? <Button href="/start">Обновить мост</Button> : undefined} />}
            <Space wrap>
                <Button
                    disabled={!!restoreError || !!bridgeError || !canWrite || !bridge.devicesReady || !bridge.jobsReady || !binding || pending || busy}
                    title={bridgeError || restoreError || undefined}
                    loading={busy}
                    onClick={() => {
                        void create('restore-rag');
                    }}
                >
                    Скачать в проект через мост
                </Button>
                <Button
                    disabled={!!bridgeError || !canWrite || !bridge.devicesReady || !bridge.jobsReady || !binding || pending || busy}
                    title={bridgeError || undefined}
                    onClick={() => {
                        void create('sync-rag');
                    }}
                >
                    Синхронизировать с сервером
                </Button>
            </Space>
            {restoreError && <Typography.Text type="secondary">{restoreError}</Typography.Text>}
            {bridge.device && bridge.devicesReady && !binding && (
                <span>Папка проекта ещё не связана с мостом. <Link to={projectBindingUrl(projectId)}>Связать папку проекта</Link></span>
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
