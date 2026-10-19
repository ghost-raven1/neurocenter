import { Alert, Button, Checkbox, Empty, List, Modal, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { IBridgeInstallation } from './api';
import type { ILocalVariant, ILocalVariants } from './operationTypes';
import type { useBridge } from './useBridge';
import { useLocalJob } from './useLocalJob';
import { isPending, removalSelection } from './installationHelpers';
import { installedTuple, localActionBlocker, matchingChangePlan, sameInstallation } from './operationHelpers';
import { inventoryScope, localVariantsBlocker, matchingVariants, projectBinding, variantReasonLabels } from './inventoryHelpers';
import { LocalChangePreview } from './LocalChangePreview';
import { prepareSelectedRestore, receiveRestorePreview, restoreSelectionCanApply, restoreSelectionPrepared, selectRestorePaths, type IRestoreSelection } from './localRestoreSelection';
import { consumeLocalJobResult } from './localJobResult';

/** Восстанавливает выбранный ручной вариант через новый preview, сохраняя нынешние байты перед заменой. */
export function LocalVariantsModal({item,bridge,canManage,canView,onClose}: {item:IBridgeInstallation;bridge:ReturnType<typeof useBridge>;canManage:boolean;canView:boolean;onClose():void}) {
    const [list,setList]=useState<{value:ILocalVariants;scope:string}>(); const [selected,setSelected]=useState<ILocalVariant>();
    const [restoration,setRestoration]=useState<IRestoreSelection>(); const [applied,setApplied]=useState(false);
    const [now,setNow]=useState(Date.now()); const initial=useRef(false); const operation=useLocalJob(bridge);
    const latest=useRef({bridge,canManage,canView}); latest.current={bridge,canManage,canView};
    const scope=inventoryScope(bridge.device,item.projectId); const requestedScope=useRef(scope); const instanceId=projectBinding(bridge.device,item.projectId)?.instanceId;
    const current=removalSelection(item,bridge.installations,bridge.device);
    const mutations=bridge.jobs.filter(job=>sameInstallation(job,item)&&job.state==='succeeded'
        && ['install','uninstall','apply-local-change','apply-local-restore','apply-adopt-installation'].includes(job.kind)).map(job=>job.id+':'+job.updatedAt).sort();
    const context=JSON.stringify([scope,canManage,canView,current?.version,current?.manifest,current?.updatedAt,mutations]);
    const sourceContext=useRef(context); const processed=useRef(new Set<string>());
    const preparation=useRef<{context:string;recoveryId:string;paths?:string[]}>();
    const plan=restoration?.plan; const confirmed=restoration?.confirmed===true;
    const selectionPrepared=restoreSelectionPrepared(restoration,context);
    const mutationBlocker=(live=latest.current) => localActionBlocker(item,live.bridge.installations,live.bridge.device,live.bridge.jobs,
        !!(live.bridge.devicesReady && live.bridge.jobsReady && live.bridge.installationsReady),live.canManage,'local-recovery-v1',operation.job?.id);
    const blocker=(live=latest.current) => localVariantsBlocker(item,live.bridge.installations,live.bridge.device,live.bridge.jobs,
        !!(live.bridge.devicesReady && live.bridge.jobsReady && live.bridge.installationsReady),live.canView,operation.job?.id);
    const reason=blocker(); const locked=operation.busy || isPending(operation.job);
    const listCurrent=!!list && list.scope === scope && !!matchingVariants(list.value,item,instanceId);
    const listExpired=!!list && (Date.parse(list.value.checkedAt)>now+5000 || now-Date.parse(list.value.checkedAt)>15*60000);
    const expired=!!plan && Date.parse(plan.expiresAt)<=now;
    const valid=!!plan && !!matchingChangePlan(plan,item,instanceId);
    useEffect(() => { const timer=setInterval(() => setNow(Date.now()),1000); return () => clearInterval(timer); },[]);
    useEffect(() => {
        if(sourceContext.current!==context){sourceContext.current=context;setRestoration(undefined);setSelected(undefined);
            setApplied(operation.job?.kind==='apply-local-restore'&&operation.job.state==='succeeded');preparation.current=undefined;}
    },[context]);
    useEffect(() => {
        if (initial.current) { return; } initial.current=true;
        if (!blocker()) { void operation.submit({kind:'list-local-variants',...installedTuple(item)}); }
    },[]);
    useEffect(() => {
        if (!consumeLocalJobResult(processed.current,operation.job,context,operation.job?.kind==='prepare-local-restore'?preparation.current?.context:context)) { return; }
        const completed=operation.job!;
        if (completed.kind === 'list-local-variants') {
            const result=matchingVariants(completed.result,item,instanceId);
            if (result && requestedScope.current === scope) { setList({value:result,scope}); setSelected(undefined); setRestoration(undefined); setApplied(false); }
            else { operation.setError('Список не соответствует выбранной установке или экземпляру папки.'); }
        }
        if (completed.kind === 'prepare-local-restore') {
            const result=matchingChangePlan(completed.result,item,instanceId);
            const request=preparation.current;
            if (result && request?.context===context) {
                try { setRestoration(receiveRestorePreview(restoration,result,context,request.recoveryId,request.paths)); }
                catch(cause){setRestoration(undefined);setSelected(undefined);operation.setError((cause as Error).message);}
            } else { operation.setError('Подготовка восстановления не соответствует выбранной установке или актуальному состоянию.'); }
        }
        if (completed.kind === 'apply-local-restore') { setApplied(true); }
    },[operation.job?.id,operation.job?.state,operation.job?.result,instanceId,scope,context]);
    const submit=async (kind:'list-local-variants'|'prepare-local-restore'|'apply-local-restore'|'open-local-change-report'|'open-local-recovery-folder',variant?:ILocalVariant) => {
        const blocked=kind === 'list-local-variants' ? blocker() : mutationBlocker(); if (blocked || locked) { operation.setError(blocked); return; }
        if (kind === 'list-local-variants') { requestedScope.current=inventoryScope(latest.current.bridge.device,item.projectId);setRestoration(undefined);setSelected(undefined);preparation.current=undefined;await operation.submit({kind,...installedTuple(item)}); return; }
        if (kind === 'open-local-recovery-folder') { await operation.submit({kind,deviceId:item.deviceId,projectId:item.projectId,expectedBindingId:item.bindingId!}); return; }
        if (kind === 'prepare-local-restore') {
            if (!variant?.eligible || !listCurrent || listExpired || !list?.value.entries.some(entry => entry.recoveryId === variant.recoveryId && entry.eligible)) { return; }
            setSelected(variant); setRestoration(undefined); setApplied(false);preparation.current={context,recoveryId:variant.recoveryId};
            await operation.submit({kind,...installedTuple(item),recoveryId:variant.recoveryId}); return;
        }
        if (!plan || !valid || expired || !selected || !selectionPrepared || kind === 'apply-local-restore' && !restoreSelectionCanApply(restoration,context)) { return; }
        await operation.submit({kind,...installedTuple(item),changePlanId:plan.planId,changePlanRevision:plan.revision,expectedChangeDigest:plan.digest});
    };
    const prepareSelection=async()=>{
        if(!restoration||locked||mutationBlocker()){return;}
        try{const prepared=prepareSelectedRestore(item,restoration,context);setRestoration(prepared.selection);
            preparation.current={context,recoveryId:restoration.recoveryId,paths:[...restoration.paths]};await operation.submit(prepared.input);
        }catch(cause){operation.setError((cause as Error).message);}
    };
    return <Modal open title={`Сохранённые локальные варианты: «${item.name}»`} footer={null} width={780} onCancel={() => { if (!operation.busy) { onClose(); } }}>
        <Space direction="vertical" size={16} className="local-operation">
            <Typography.Text>Папка: <strong>{item.folderName || 'Выбранная папка проекта'}</strong> · версия {item.version}</Typography.Text>
            <Alert type="warning" showIcon message="Ручной вариант не является одобренной версией каталога" description="Сначала просмотрите точные изменения. Перед применением нынешнее состояние сохранится в новой локальной копии. Восстанавливаются только доказанные файлы и собственные подключения инструмента, без полной замены конфигурации и метаданных. Автоматического запуска не будет." />
            <Space wrap><Button disabled={locked || !!reason} onClick={() => { void submit('list-local-variants'); }}>Обновить список</Button>
                <Button disabled={locked || !!mutationBlocker()} onClick={() => { void submit('open-local-recovery-folder'); }}>Открыть резервные копии на компьютере</Button></Space>
            {!canManage && <Alert type="info" showIcon message="Список доступен для просмотра. Подготовка и применение восстановления требуют роли разработчика." />}
            {list && (!listCurrent || listExpired) && <Alert type="warning" showIcon message="Папка или данные списка изменились. Обновите список перед выбором варианта." />}
            {list && listCurrent && !plan && <>
                <Typography.Text type="secondary">Проверено: {new Date(list.value.checkedAt).toLocaleString('ru-RU')}</Typography.Text>
                {!list.value.complete && <Alert type="warning" showIcon message="Список неполный: показаны только проверенные записи в пределах лимита" />}
                {list.value.entries.length ? <List size="small" rowKey="recoveryId" dataSource={list.value.entries} renderItem={variant => <List.Item><div className="local-installations__item">
                    <div className="local-installations__summary"><Typography.Text strong>{new Date(variant.createdAt).toLocaleString('ru-RU')}</Typography.Text>
                        <Typography.Text>Файлов для проверки: {variant.files}</Typography.Text><Typography.Text type="secondary">{variantReasonLabels[variant.reason]}</Typography.Text></div>
                    <Button disabled={!variant.eligible || locked || !!mutationBlocker() || listExpired} title={mutationBlocker() || undefined} onClick={() => { void submit('prepare-local-restore',variant); }}>Просмотреть восстановление</Button>
                </div></List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Для этой установки нет сохранённых локальных вариантов" />}
            </>}
            {plan && restoration && <><Typography.Text strong>Вариант от {selected && new Date(selected.createdAt).toLocaleString('ru-RU')}</Typography.Text>
                {!applied && <><Typography.Text strong>Выберите возвращаемые изменения</Typography.Text>
                    <List size="small" className="local-operation__files" dataSource={restoration.fullFiles} rowKey="path" renderItem={file=><List.Item>
                        <Checkbox checked={restoration.paths.includes(file.path)} disabled={locked||!!mutationBlocker()} onChange={event=>setRestoration(previous=>previous&&selectRestorePaths(previous,event.target.checked?[...previous.paths,file.path]:previous.paths.filter(path=>path!==file.path)))}>
                            <Typography.Text className="local-operation__hash">{file.path}</Typography.Text>
                        </Checkbox></List.Item>} />
                    <Button disabled={locked||!!mutationBlocker()||!restoration.paths.length} onClick={()=>{void prepareSelection();}}>Подготовить выбранные изменения</Button>
                    {!selectionPrepared&&<Alert type="info" showIcon message={restoration.paths.length?'Выбор изменился. Подготовьте новый план для выбранных файлов.':'Выберите хотя бы один файл.'} />}
                </>}
                {selectionPrepared&&<LocalChangePreview plan={plan} />}
                {!applied && <><Button disabled={locked || !!mutationBlocker() || expired || !valid || !selectionPrepared} onClick={() => { void submit('open-local-change-report'); }}>Открыть полный diff на компьютере</Button>
                    <Checkbox checked={confirmed} disabled={locked || !!mutationBlocker() || expired || !valid || !selectionPrepared} onChange={event => setRestoration(previous=>previous&&{...previous,confirmed:event.target.checked})}>Подтверждаю весь показанный набор изменений и сохранение нынешнего состояния</Checkbox>
                    <Space wrap><Button disabled={locked} onClick={() => { setRestoration(undefined);setSelected(undefined);preparation.current=undefined; }}>Выбрать другой вариант</Button>
                        <Button type="primary" disabled={locked || !!mutationBlocker() || !restoreSelectionCanApply(restoration,context) || !valid || expired || !plan.files.length} onClick={() => { void submit('apply-local-restore'); }}>Сохранить нынешний вариант и восстановить выбранный</Button></Space></>}
            </>}
            {applied && <Alert type="success" showIcon message="Выбранный локальный вариант восстановлен" description="Версия каталога не изменена. Повторите сверку файлов; ручные отличия могут остаться. Диагностика запуска доступна отдельно после проверки." />}
            {expired && <Alert type="warning" showIcon message="Подготовка устарела. Вернитесь к списку и подготовьте восстановление заново." />}
            {reason && <Alert type="warning" showIcon message={reason} />}
            {operation.job && <Alert role="status" type={operation.job.state === 'failed' ? 'error' : 'info'} showIcon message={operation.job.message} />}
            {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        </Space>
    </Modal>;
}
