import { Alert, Button, Space, Typography } from 'antd';
import { useEffect, useRef, useState, type FC } from 'react';
import { Link } from 'react-router-dom';
import { bridgeApi, type IBridgeJob } from './api';
import { useBridge } from './useBridge';
import { BridgeConnection } from './BridgeConnection';
import { errorMessage } from '../../common/utils/errorMessage';
import { isPending } from './installationHelpers';
import { bridgeOperationBlocker } from './readiness';
import { currentKnowledgeJob, knowledgeSyncBlocker, validKnowledgeAck, type KnowledgeJobKind } from './knowledgeSyncState';
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
    const [submitted, setSubmitted] = useState<{scope: string; epoch: number; job: IBridgeJob}>();
    const lock = useRef(false);
    const binding = bridge.device?.report.bindings?.find(
        (item) => item.projectId === projectId && item.valid !== false && /^[a-f0-9]{64}$/.test(item.bindingId || ''),
    );
    const scope = JSON.stringify([ownerScope,projectId,bridge.device?.id,bridge.device?.report.root,binding?.bindingId,binding?.instanceId,canWrite]);
    const currentScope = useRef({scope, epoch: 0});
    if (currentScope.current.scope !== scope) { currentScope.current = {scope, epoch: currentScope.current.epoch + 1}; }
    const epoch = currentScope.current.epoch;
    const request = useRef<{scope:string;epoch:number;kind:KnowledgeJobKind;key:string;accepted?:IBridgeJob}>();
    if (request.current?.scope !== scope || request.current.epoch !== epoch) { request.current = undefined; }
    const accepted = submitted?.scope === scope && submitted.epoch === epoch ? submitted.job : undefined;
    const job = currentKnowledgeJob(bridge.jobs, bridge.device?.id, projectId, binding?.bindingId, accepted, bridge.jobsReady);
    const pending = isPending(job);
    if (request.current?.accepted && !pending) { request.current = undefined; }
    const sequence = useRef(0);
    useEffect(() => {
        sequence.current++; lock.current = false; setBusy(false); setError(''); setSubmitted(undefined);
        return () => { sequence.current++; };
    },[scope]);
    useEffect(() => {
        // Свежий итог заменяет локальный queued ACK и переживает следующий отказ чтения.
        if (accepted && bridge.jobsReady && job?.id === accepted.id && !isPending(job) && job !== accepted
            && captureOwner()() && currentScope.current.scope === scope && currentScope.current.epoch === epoch) {
            setSubmitted({scope, epoch, job});
        }
    }, [accepted, bridge.jobsReady, job, scope, epoch, captureOwner]);
    const create = async (kind: KnowledgeJobKind): Promise<void> => {
        const owns = captureOwner();
        const localPending = isPending(currentKnowledgeJob(bridge.jobs, bridge.device?.id, projectId, binding?.bindingId, request.current?.accepted, bridge.jobsReady));
        if (!owns() || currentScope.current.scope !== scope || currentScope.current.epoch !== epoch || !bridge.device || bridgeError
            || (kind === 'restore-rag' && restoreError) || !bridge.devicesReady || !bridge.jobsReady || !binding || !canWrite || pending || localPending || lock.current) {
            return;
        }
        lock.current = true;
        const ticket = ++sequence.current;
        const current = (): boolean => owns() && ticket === sequence.current && currentScope.current.scope === scope && currentScope.current.epoch === epoch;
        setBusy(true);
        setError('');
        try {
            // Потерянный ответ повторяет исходный POST; смена направления означает новое действие.
            if (request.current?.kind !== kind) { request.current = undefined; }
            const saved = request.current ?? {scope,epoch,kind,key:createBridgeRequestKey()};
            request.current = saved;
            const acceptedJob = await bridgeApi.create({
                deviceId: bridge.device.id,
                projectId,
                kind,
                expectedBindingId: binding.bindingId,
                requestKey: saved.key,
            });
            if (current()) {
                if (!validKnowledgeAck(acceptedJob, bridge.device.id, projectId, binding.bindingId!, kind)) {
                    throw new Error('Сервер вернул неполное подтверждение задания. Повторите отправку: исходный ключ сохранён.');
                }
                saved.accepted = acceptedJob;
                setSubmitted({scope, epoch, job: acceptedJob});
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
    const refresh = async (): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current || currentScope.current.scope !== scope || currentScope.current.epoch !== epoch) { return; }
        const saved = request.current, ticket = ++sequence.current;
        const current = (): boolean => owns() && ticket === sequence.current && currentScope.current.scope === scope && currentScope.current.epoch === epoch;
        lock.current = true; setBusy(true); setError('');
        try {
            // Завершённое задание могло выпасть из последних 100 записей: исходный POST возвращает его по тому же ключу.
            if (saved?.accepted && bridge.jobsReady && !bridge.loading && bridge.device && binding
                && !bridge.jobs.some(item => item.id === saved.accepted!.id)) {
                const reconciled = await bridgeApi.create({deviceId: bridge.device.id, projectId, kind: saved.kind,
                    expectedBindingId: binding.bindingId, requestKey: saved.key});
                if (!current() || request.current !== saved) { return; }
                if (!validKnowledgeAck(reconciled, bridge.device.id, projectId, binding.bindingId!, saved.kind)
                    || reconciled.id !== saved.accepted.id) {
                    throw new Error('Не удалось подтвердить исходное задание. Сохранён прежний ключ запроса.');
                }
                saved.accepted = reconciled;
                setSubmitted({scope, epoch, job: reconciled});
            }
            if (current()) {
                void bridge.reload().catch(() => {
                    if (current()) { setError('Задание принято, но не удалось обновить его состояние. Обновите данные.'); }
                });
            }
        } catch (cause) {
            if (current()) { setError(errorMessage(cause, 'Не удалось обновить состояние принятого задания.')); }
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
                action={!bridge.device.report.capabilities?.includes('project-rag-generations-v1') ? <Button href="/start">Обновить мост</Button> : undefined} />}
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
            {accepted && pending && <>
                {!bridge.jobsReady && <Alert type="warning" showIcon message="Задание принято, но состояние очереди недоступно"
                    description={bridge.errors?.jobs || 'Обновите сведения о задании. Повторный запуск пока заблокирован.'} />}
                <Button loading={busy || bridge.loading} onClick={() => { void refresh(); }}>Обновить состояние задания</Button>
            </>}
            {error && <Alert role="alert" type="error" message={error} />}
        </Space>
    );
};
