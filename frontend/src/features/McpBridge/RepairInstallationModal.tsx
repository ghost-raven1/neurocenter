import { Alert, Button, Checkbox, Modal, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { IBridgeInstallation } from './api';
import type { ILocalChangePlan } from './operationTypes';
import type { useBridge } from './useBridge';
import { useLocalJob } from './useLocalJob';
import { installedTuple, localActionBlocker, matchingChangePlan } from './operationHelpers';
import { isPending } from './installationHelpers';
import { LocalChangePreview } from './LocalChangePreview';
import './localOperations.less';

/** В браузер передаются только пути внутри проекта, размеры и SHA; полный diff открывается локально. */
export function RepairInstallationModal({item,bridge,canManage,onClose}: {item:IBridgeInstallation;bridge:ReturnType<typeof useBridge>;canManage:boolean;onClose():void}) {
    const [plan,setPlan] = useState<ILocalChangePlan>(); const [confirmed,setConfirmed] = useState(false); const [now,setNow] = useState(Date.now());
    const [applied,setApplied] = useState(false);
    const acceptedPlan = useRef('');
    const operation = useLocalJob(bridge);
    const latest = useRef({bridge,canManage}); latest.current = {bridge,canManage};
    const binding = bridge.device?.report.bindings?.find(value => value.projectId === item.projectId && value.bindingId === item.bindingId);
    const reason = localActionBlocker(item,bridge.installations,bridge.device,bridge.jobs,
        !!(bridge.devicesReady && bridge.jobsReady && bridge.installationsReady),canManage,'local-change-plan-v1',operation.job?.id);
    const validPlan = plan && matchingChangePlan(plan,item,binding?.instanceId);
    const expired = !!plan && Date.parse(plan.expiresAt) <= now;
    const locked = operation.busy || isPending(operation.job);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()),1000); return () => clearInterval(timer); },[]);
    useEffect(() => {
        if (operation.job?.kind === 'prepare-local-change' && operation.job.state === 'succeeded') {
            const value = matchingChangePlan(operation.job.result,item,binding?.instanceId);
            if (value) {
                const pin = `${operation.job.id}:${value.planId}:${value.revision}:${value.digest}`;
                // Повторный poll того же плана не отменяет уже данное согласие.
                if (acceptedPlan.current !== pin) {
                    acceptedPlan.current = pin; setPlan(value); setConfirmed(false); setApplied(false);
                }
            }
            else { operation.setError('Ответ моста не соответствует выбранной установке. Подготовьте сравнение заново.'); }
        }
        if (operation.job?.kind === 'apply-local-change' && operation.job.state === 'succeeded') { setApplied(true); }
    },[operation.job?.id,operation.job?.state,operation.job?.result,binding?.instanceId]);
    const submit = async (kind:'prepare-local-change'|'apply-local-change'|'open-local-change-report'|'open-local-recovery-folder') => {
        const current = latest.current;
        const blocked = localActionBlocker(item,current.bridge.installations,current.bridge.device,current.bridge.jobs,
            !!(current.bridge.devicesReady && current.bridge.jobsReady && current.bridge.installationsReady),current.canManage,'local-change-plan-v1',operation.job?.id);
        if (blocked || locked) { operation.setError(blocked); return; }
        if (kind === 'open-local-recovery-folder') {
            await operation.submit({kind,deviceId:item.deviceId,projectId:item.projectId,expectedBindingId:item.bindingId!});
            return;
        }
        if (kind !== 'prepare-local-change' && (!plan || !validPlan || Date.parse(plan.expiresAt) <= Date.now() || kind === 'apply-local-change' && !confirmed)) { return; }
        await operation.submit({kind,...installedTuple(item),...(kind !== 'prepare-local-change' && plan ? {
            changePlanId:plan.planId,changePlanRevision:plan.revision,expectedChangeDigest:plan.digest} : {})});
    };
    return <Modal open title={`Восстановление «${item.name}»`} footer={null} width={780} onCancel={() => { if (!operation.busy) { onClose(); } }}>
        <Space direction="vertical" size={16} className="local-operation">
            <Typography.Text>Папка: <strong>{item.folderName || binding?.folderName || 'Выбранная папка проекта'}</strong> · версия {item.version}</Typography.Text>
            <Typography.Paragraph>Сначала мост сравнит файлы с точной одобренной версией. Перед заменой локальный вариант сохранится в резервной копии на компьютере.</Typography.Paragraph>
            {reason && <Alert type="warning" showIcon message={reason} />}
            <Button disabled={!!reason || locked} onClick={() => { void submit('open-local-recovery-folder'); }}>Открыть резервные копии на компьютере</Button>
            {operation.job?.kind === 'open-local-recovery-folder' && operation.job.state === 'succeeded' && <Typography.Text type="secondary">Папка резервных копий открыта на выбранном компьютере.</Typography.Text>}
            {!plan && <Button type="primary" disabled={!!reason || locked} loading={locked} onClick={() => { void submit('prepare-local-change'); }}>Сравнить файлы</Button>}
            {plan && <>
                <LocalChangePreview plan={plan} />
                {expired && <Alert type="warning" showIcon message="Сравнение устарело. Подготовьте его заново перед восстановлением." />}
                {!validPlan && <Alert type="warning" showIcon message="Экземпляр папки изменился. Закройте окно и откройте текущую установку." />}
                {!applied && <>
                    <Button disabled={!!reason || locked || expired || !validPlan} onClick={() => { void submit('open-local-change-report'); }}>Открыть полный diff на компьютере</Button>
                    {operation.job?.kind === 'open-local-change-report' && operation.job.state === 'succeeded' && <Typography.Text type="secondary">Отчёт открыт на выбранном компьютере.</Typography.Text>}
                    <Checkbox checked={confirmed} disabled={locked || expired || !validPlan || !!reason} onChange={event => setConfirmed(event.target.checked)}>
                        {plan.runtimeRepairRequired
                            ? 'Подтверждаю повторную загрузку готового комплекта и указанные изменения. Прежние варианты будут сохранены.'
                            : 'Подтверждаю изменения файлов и сохранение моего локального варианта перед восстановлением'}
                    </Checkbox>
                    <Space wrap><Button disabled={locked || !!reason} onClick={() => { setPlan(undefined); void submit('prepare-local-change'); }}>Сравнить заново</Button>
                        <Button type="primary" disabled={locked || !!reason || !validPlan || expired || !confirmed || (!plan.files.length && !plan.runtimeRepairRequired)}
                            loading={operation.busy || operation.job?.kind === 'apply-local-change' && isPending(operation.job)} onClick={() => { void submit('apply-local-change'); }}>
                            {plan.runtimeRepairRequired && !plan.files.length ? 'Восстановить готовый комплект' : 'Сохранить локальный вариант и восстановить'}</Button></Space>
                </>}
            </>}
            {applied && <Alert type="success" showIcon message={plan?.runtimeRepairRequired && !plan.files.length ? 'Готовый комплект восстановлен' : 'Локальный вариант сохранён, одобренные файлы восстановлены'} description="Повторите сверку файлов и диагностику запуска. Старые результаты больше не подтверждают эту установку." />}
            {operation.job && <Alert role="status" showIcon type={operation.job.state === 'failed' ? 'error' : 'info'} message={operation.job.message} />}
            {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        </Space>
    </Modal>;
}
