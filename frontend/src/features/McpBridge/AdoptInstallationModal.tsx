import { Alert, Button, Checkbox, Modal, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridgeApi, type IBridgeInstallation, type IInstallPlan } from './api';
import type { ILocalChangePlan, IProjectInventory, IProjectInventoryEntry } from './operationTypes';
import type { useBridge } from './useBridge';
import { useLocalJob } from './useLocalJob';
import { isPending } from './installationHelpers';
import { adoptionCandidateBlocker, approvedAdoptionTarget, inventoryMutationBlocker, inventoryScope, matchingAdoptionPlan, matchingInventory, projectInventoryBlocker } from './inventoryHelpers';
import { ApprovedProjectTarget } from './ApprovedProjectTarget';
import { LocalChangePreview } from './LocalChangePreview';
import { errorMessage } from '../../common/utils/errorMessage';
import { consumeLocalJobResult } from './localJobResult';

interface Props {
    bridge:ReturnType<typeof useBridge>; canManage:boolean; inventory:IProjectInventory; inventoryJobId:string; scope:string;
    entry:IProjectInventoryEntry; catalog:Array<{id:string;kind:string;name:string}>; onClose():void;
}
/** Принятие существующих файлов не является установкой: разрешена только явная запись проверенных метаданных. */
export function AdoptInstallationModal({bridge,canManage,inventory,inventoryJobId,scope,entry,catalog,onClose}: Props) {
    const [approved,setApproved] = useState<IInstallPlan>(); const [plan,setPlan] = useState<ILocalChangePlan>(); const [confirmed,setConfirmed] = useState(false);
    const [checking,setChecking] = useState(false); const [now,setNow] = useState(Date.now()); const [applied,setApplied] = useState(false);
    const operation=useLocalJob(bridge); const gate=useRef(false); const deviceId=useRef(bridge.device?.id || ''); const latest=useRef({bridge,canManage}); latest.current={bridge,canManage};
    const processed=useRef(new Set<string>());const preparation=useRef<string>();
    const context=JSON.stringify([inventoryScope(bridge.device,inventory.projectId),canManage,scope,inventory.scanId,inventory.digest,entry.candidateId,
        approved?.id,approved?.revision,approved?.manifest,approved?.assetId,approved?.assetKind,approved?.version]);
    const target = (approval:IInstallPlan): IBridgeInstallation => ({deviceId:deviceId.current,projectId:inventory.projectId,assetId:approval.assetId,
        assetKind:approval.assetKind,version:approval.version,manifest:approvedAdoptionTarget(approval,approval).manifest,name:entry.path,
        bindingId:inventory.bindingId,isCurrentBinding:true,updatedAt:inventory.checkedAt});
    const blocker = (live=latest.current) => projectInventoryBlocker(live.bridge.device,inventory.projectId,live.bridge.jobs,
        !!(live.bridge.devicesReady && live.bridge.jobsReady),live.canManage,'adopt-installation-v1',operation.job?.id)
        || (scope !== inventoryScope(live.bridge.device,inventory.projectId) || !matchingInventory(inventory,inventory.projectId,live.bridge.device)
            ? 'Папка или экземпляр изменились. Выполните новый поиск.' : inventoryMutationBlocker(inventory,live.bridge.jobs,deviceId.current) || adoptionCandidateBlocker(inventory,entry));
    const reason=blocker(); const locked=checking || operation.busy || isPending(operation.job);
    const expired=!!plan && Date.parse(plan.expiresAt)<=now;
    const valid=!!plan && !!approved && !!matchingAdoptionPlan(plan,target(approved),inventory.instanceId);
    const choose = useCallback((value:IInstallPlan|undefined) => { preparation.current=undefined;setApproved(value); setPlan(undefined); setConfirmed(false); },[]);
    useEffect(() => { const timer=setInterval(() => setNow(Date.now()),1000); return () => clearInterval(timer); },[]);
    useEffect(() => {
        if (operation.job?.kind === 'prepare-adopt-installation' && operation.job.state === 'succeeded' && approved) {
            if(!consumeLocalJobResult(processed.current,operation.job,context,preparation.current)){return;}
            const result=matchingAdoptionPlan(operation.job.result,target(approved),inventory.instanceId);
            if (result) { setPlan(result); setConfirmed(false); } else { operation.setError('Ответ принятия не соответствует выбранным инструменту и папке.'); }
        }
        if (operation.job?.kind === 'apply-adopt-installation' && operation.job.state === 'succeeded') { setApplied(true); }
    },[operation.job?.id,operation.job?.state,operation.job?.result,approved,context]);
    const prepare=async () => {
        if (!approved || gate.current || locked || blocker()) { return; } gate.current=true; setChecking(true); operation.setError('');
        try {
            const live=await bridgeApi.plan(approved.id); approvedAdoptionTarget(live,approved);
            if (live.projectId !== inventory.projectId || live.revision !== approved.revision || live.manifest !== approved.manifest) { throw new Error('Одобрение изменилось. Выберите точную версию заново.'); }
            const blocked=blocker(); if (blocked) { throw new Error(blocked); }
            preparation.current=context;setConfirmed(false);
            await operation.submit({kind:'prepare-adopt-installation',deviceId:latest.current.bridge.device!.id,projectId:inventory.projectId,
                assetId:live.assetId,assetKind:live.assetKind,version:live.version,planId:live.id,planRevision:live.revision,expectedManifest:live.manifest,
                expectedBindingId:inventory.bindingId,inventoryJobId,scanId:inventory.scanId,candidateId:entry.candidateId,expectedInventoryDigest:inventory.digest});
        } catch(cause) { operation.setError(errorMessage(cause,'Не удалось подготовить принятие.')); }
        finally { gate.current=false; setChecking(false); }
    };
    const apply=async () => {
        if (!approved || !plan || !confirmed || !valid || expired || locked || blocker()) { return; }
        await operation.submit({kind:'apply-adopt-installation',deviceId:deviceId.current,projectId:inventory.projectId,assetId:plan.assetId,assetKind:plan.assetKind,
            expectedManifest:plan.manifest,expectedBindingId:plan.bindingId,changePlanId:plan.planId,changePlanRevision:plan.revision,expectedChangeDigest:plan.digest});
    };
    return <Modal open title="Принять существующий инструмент под управление" footer={null} width={760} onCancel={() => { if (!checking && !operation.busy) { onClose(); } }}>
        <Space direction="vertical" size={16} className="local-operation">
            <Typography.Text code className="local-operation__hash">{entry.path}</Typography.Text>
            <Alert type="info" showIcon message="Выберите точный одобренный инструмент" description="Мост проверит существующие файлы и подключения. Принимаются только совпадающие канонические пути; содержимое и конфигурация не переносятся и не заменяются." />
            {!plan && <ApprovedProjectTarget projectId={inventory.projectId} kind={entry.kind} catalog={catalog} disabled={locked || !!reason} onChange={choose} />}
            {!plan && <Button type="primary" disabled={!approved || !!reason || locked} loading={locked} onClick={() => { void prepare(); }}>Проверить возможность принятия</Button>}
            {plan && <><LocalChangePreview plan={plan} />
                <Typography.Paragraph>Изменяются только проверенные метаданные управления. Файлы инструмента и действующие подключения OpenCode сохранятся. Запуск не выполняется.</Typography.Paragraph>
                {!applied && <><Checkbox checked={confirmed} disabled={locked || expired || !valid || !!reason} onChange={event => setConfirmed(event.target.checked)}>Подтверждаю принятие этого точного инструмента под управление</Checkbox>
                    <Space wrap><Button disabled={locked} onClick={() => { setPlan(undefined); setConfirmed(false); }}>Изменить выбор</Button>
                        <Button type="primary" disabled={!confirmed || !valid || expired || locked || !!reason} onClick={() => { void apply(); }}>Принять под управление</Button></Space></>}
            </>}
            {applied && <Alert type="success" showIcon message="Инструмент принят под управление" description="Повторите сверку файлов. Диагностика запуска выполняется отдельно, с новым согласием." />}
            {expired && <Alert type="warning" message="Подготовка устарела. Выберите инструмент и выполните проверку заново." />}
            {reason && <Alert type="warning" showIcon message={reason} />}
            {operation.job && <Alert role="status" showIcon type={operation.job.state === 'failed' ? 'error' : 'info'} message={operation.job.message} />}
            {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        </Space>
    </Modal>;
}
