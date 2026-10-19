import { Alert, Button, Checkbox, Descriptions, Modal, Select, Space, Steps, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { bridgeApi, type IBridgeJobDraft } from './api';
import type { IWorkspacePreparation, TWorkspaceBindingMode } from './operationTypes';
import type { useBridge } from './useBridge';
import { useLocalJob } from './useLocalJob';
import { isPending } from './installationHelpers';
import { workspaceBlocker } from './readiness';
import { matchingWorkspacePreparation, workspaceBindingNotice, workspaceModeDescriptions, workspaceModeLabels, workspaceSnapshot, workspaceSource } from './workspaceBinding';
import './localOperations.less';

type WorkspaceDraft = Extract<IBridgeJobDraft, {kind:'prepare-bind-project'|'bind-project'}>;
/** Привязка проходит preview: код папки сам по себе не подтверждает локальный экземпляр. */
export function WorkspaceBindingWizard({bridge, project, canManage = false, onClose}: {bridge: ReturnType<typeof useBridge>; project: {id:string;name:string}; canManage?:boolean; onClose():void}) {
    const binding = bridge.device?.report.bindings?.find(item => item.projectId === project.id);
    const [folderName, setFolderName] = useState(binding?.folderName);
    const [mode, setMode] = useState<TWorkspaceBindingMode>(binding?.identityStatus === 'legacy' ? 'adopt-legacy' : 'new');
    const [request, setRequest] = useState<{input:WorkspaceDraft;snapshot:string;deviceName:string;sourceFolderName?:string;jobId?:string}>();
    const [prepared, setPrepared] = useState<{value:IWorkspacePreparation;jobId:string;expiresAt:number}>();
    const [now,setNow] = useState(Date.now());
    const [confirmed, setConfirmed] = useState(false);
    const operation = useLocalJob(bridge);
    const latest = useRef({bridge,project,canManage}); latest.current = {bridge,project,canManage};
    const readError = bridge.errors.devices || bridge.errors.jobs;
    const blocker = !canManage ? 'Для привязки нужна роль разработчика в этом проекте.' : workspaceBlocker(bridge.device) || readError || (!bridge.devicesReady || !bridge.jobsReady ? 'Дождитесь актуальных данных компьютера и очереди.' : '');
    const otherPending = bridge.jobs.find(job => job.deviceId === bridge.device?.id && isPending(job) && job.id !== operation.job?.id
        && (job.kind === 'choose-root' || job.projectId === project.id));
    const stale = !!request && request.snapshot !== workspaceSnapshot(bridge.device, project.id);
    const expired = !!prepared && (!Number.isFinite(prepared.expiresAt) || prepared.expiresAt <= now);
    const pending = isPending(operation.job); const locked = operation.busy || pending;
    const needsRecheck = operation.job?.kind === 'bind-project' && operation.job.state === 'failed';
    const bindingNotice = workspaceBindingNotice(binding);
    useEffect(() => {
        if (operation.job?.kind === 'prepare-bind-project' && operation.job.state === 'succeeded' && request?.jobId === operation.job.id) {
            const value = matchingWorkspacePreparation(operation.job.result, request.input);
            if (value) { setPrepared({value,jobId:operation.job.id,expiresAt:Date.parse(operation.job.updatedAt)+15*60000}); }
            else { operation.setError('Ответ моста не соответствует выбранной папке. Подготовьте проверку заново.'); }
        }
        if (operation.job?.kind === 'bind-project' && operation.job.state === 'succeeded') { onClose(); }
    }, [operation.job?.id,operation.job?.state,operation.job?.result,request]);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()),1000); return () => clearInterval(timer); },[]);
    const reset = () => { setPrepared(undefined); setRequest(undefined); setConfirmed(false); operation.setError(''); };
    const prepare = async () => {
        const current = latest.current;
        if (!current.canManage || !current.bridge.device || workspaceBlocker(current.bridge.device) || !current.bridge.devicesReady || !current.bridge.jobsReady || !folderName || locked || otherPending) { return; }
        try {
            const source = workspaceSource(current.bridge.device.report.bindings?.find(item => item.projectId === current.project.id), mode);
            const input: WorkspaceDraft = {kind:'prepare-bind-project',deviceId:current.bridge.device.id,projectId:current.project.id,folderName,bindingMode:mode,...source};
            setPrepared(undefined); setConfirmed(false);
            setRequest({input,snapshot:workspaceSnapshot(current.bridge.device,current.project.id),deviceName:current.bridge.device.name,
                ...(mode !== 'new' && mode !== 'resume' ? {sourceFolderName:current.bridge.device.report.bindings?.find(item => item.projectId === current.project.id)?.folderName} : {})});
            const job = await operation.submit(input);
            if (job) { setRequest(previous => previous && previous.input === input ? {...previous,jobId:job.id} : previous); }
        } catch (cause) { operation.setError(cause instanceof Error ? cause.message : 'Не удалось подготовить привязку.'); }
    };
    const commit = async () => {
        const current = latest.current;
        if (!current.canManage || !prepared || !request || !confirmed || locked || needsRecheck || workspaceBlocker(current.bridge.device) || !current.bridge.devicesReady || !current.bridge.jobsReady
            || Date.now() >= prepared.expiresAt || request.snapshot !== workspaceSnapshot(current.bridge.device,current.project.id) || otherPending) { return; }
        await operation.submit({...request.input,kind:'bind-project',preparationJobId:prepared.jobId,expectedPreparation:prepared.value.preparation});
    };
    const sourceError = (() => { try { workspaceSource(binding,mode); return ''; } catch (cause) { return (cause as Error).message; } })();
    const cancel = (id: string) => {
        void bridgeApi.cancel(id).then(() => bridge.reload()).catch(() => operation.setError('Не удалось отменить задание. Обновите данные и повторите отмену.'));
    };
    return <Modal open title={`Папка проекта «${project.name}»`} onCancel={() => { if (!operation.busy) { onClose(); } }} footer={null} width={640}>
        <Space direction="vertical" size={16} className="local-operation">
            <Steps size="small" current={prepared ? 2 : request ? 1 : 0} items={[{title:'Папка'},{title:'Проверка моста'},{title:'Подтверждение'}]} />
            {bindingNotice && <Alert type="warning" showIcon message={bindingNotice} />}
            {!prepared && <>
                <Typography.Paragraph>Выберите папку на компьютере «{bridge.device?.name}». Мост проверит её перед привязкой.</Typography.Paragraph>
                <Select aria-label="Локальная папка проекта" style={{width:'100%'}} value={folderName} disabled={locked}
                    placeholder="Выберите папку из общей папки проектов" onChange={value => { setFolderName(value); reset(); }}
                    options={(bridge.device?.report.folders || []).map(value => ({value,label:value}))} />
                <Select aria-label="Действие с папкой" style={{width:'100%'}} value={mode} disabled={locked}
                    onChange={value => { setMode(value); reset(); }} options={Object.entries(workspaceModeLabels).map(([value,label]) => ({value,label}))} />
                <Typography.Text type="secondary">{workspaceModeDescriptions[mode]}</Typography.Text>
                {sourceError && <Alert type="info" showIcon message={sourceError} />}
                <Button type="primary" disabled={!!blocker || !!sourceError || !folderName || locked || !!otherPending} loading={operation.busy || pending}
                    onClick={() => { void prepare(); }}>Проверить выбранную папку</Button>
            </>}
            {prepared && request && <>
                <Descriptions size="small" column={1} bordered>
                    <Descriptions.Item label="Компьютер">{request.deviceName}</Descriptions.Item>
                    <Descriptions.Item label="Папка">{prepared.value.folderName}</Descriptions.Item>
                    <Descriptions.Item label="Действие">{workspaceModeLabels[prepared.value.mode]}</Descriptions.Item>
                    {(request.sourceFolderName || prepared.value.sourceFolderName) && <Descriptions.Item label="Прежняя папка">{request.sourceFolderName || prepared.value.sourceFolderName}</Descriptions.Item>}
                </Descriptions>
                <Alert type="info" showIcon message="Папка проверена мостом" description={workspaceModeDescriptions[prepared.value.mode]} />
                <Checkbox checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={locked || stale || expired || needsRecheck}>Подтверждаю выбранную папку и действие с её экземпляром</Checkbox>
                <Space wrap><Button onClick={reset} disabled={locked}>Изменить выбор</Button><Button type="primary" disabled={!confirmed || stale || expired || !!blocker || !!otherPending || locked || needsRecheck}
                    loading={operation.busy || operation.job?.kind === 'bind-project' && pending} onClick={() => { void commit(); }}>Подтвердить привязку</Button></Space>
            </>}
            {stale && <Alert type="warning" showIcon message="Компьютер или исходная привязка изменились. Подготовьте действие заново." />}
            {expired && <Alert type="warning" showIcon message="Проверка папки устарела через 15 минут. Измените выбор и повторите проверку." />}
            {blocker && <Alert type="warning" showIcon message={blocker}
                action={readError || !bridge.devicesReady || !bridge.jobsReady ? <Button size="small" loading={bridge.loading} onClick={() => { void bridge.reload(); }}>Обновить данные</Button> : undefined} />}
            {otherPending && <Alert type="info" showIcon message="Сначала дождитесь завершения другого действия с проектом." description={otherPending.message}
                action={otherPending.state === 'queued' ? <Button size="small" onClick={() => cancel(otherPending.id)}>Отменить</Button> : undefined} />}
            {operation.job && <Alert role="status" type={operation.job.state === 'failed' ? 'error' : 'info'} showIcon message={operation.job.message}
                action={operation.job.state === 'queued' ? <Button size="small" onClick={() => cancel(operation.job!.id)}>Отменить</Button>
                    : operation.job.state === 'failed' && ['prepare-bind-project','bind-project'].includes(operation.job.kind)
                        ? <Button size="small" onClick={reset} disabled={locked}>Проверить папку заново</Button> : undefined} />}
            {operation.error && <Alert type="error" role="alert" showIcon message={operation.error} />}
        </Space>
    </Modal>;
}
