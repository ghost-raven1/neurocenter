import { Alert, Button, Empty, List, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { useBridge } from './useBridge';
import type { IProjectInventory, IProjectInventoryEntry } from './operationTypes';
import { useLocalJob } from './useLocalJob';
import { isPending } from './installationHelpers';
import { adoptionCandidateBlocker, inventoryExpired, inventoryMutationBlocker, inventoryReasonLabels, inventoryScope, matchingInventory, projectBinding, projectInventoryBlocker } from './inventoryHelpers';
import { AdoptInstallationModal } from './AdoptInstallationModal';

const states={managed:'Под управлением',unmanaged:'Не под управлением',damaged:'Повреждено',unsafe:'Небезопасная запись',unreadable:'Нет доступа к чтению'};
const kinds={skill:'Скилл',mcp:'MCP',plugin:'Плагин',unknown:'Неизвестный тип'};
interface Props {bridge:ReturnType<typeof useBridge>;projectId:string;canInspect:boolean;canManage:boolean;catalog:Array<{id:string;kind:string;name:string}>;}
/** Только явное сканирование одной подтверждённой папки; найденное не становится управляемым автоматически. */
export function ProjectInventory({bridge,projectId,canInspect,canManage,catalog}: Props) {
    const [result,setResult]=useState<{value:IProjectInventory;jobId:string;scope:string}>();
    const [selected,setSelected]=useState<{entry:IProjectInventoryEntry;report:NonNullable<typeof result>}>();
    const [requestScope,setRequestScope]=useState(''); const [,setNow]=useState(Date.now()); const operation=useLocalJob(bridge);
    const scope=inventoryScope(bridge.device,projectId); const ready=!!(bridge.devicesReady && bridge.jobsReady);
    const blocker=projectInventoryBlocker(bridge.device,projectId,bridge.jobs,ready,canInspect,'project-inventory-v1',operation.job?.id);
    const adoptBlocker=projectInventoryBlocker(bridge.device,projectId,bridge.jobs,ready,canManage,'adopt-installation-v1',operation.job?.id);
    const locked=operation.busy || isPending(operation.job);
    const current=result?.scope === scope && !!matchingInventory(result.value,projectId,bridge.device) && !inventoryMutationBlocker(result.value,bridge.jobs,bridge.device?.id);
    const expired=!!result && inventoryExpired(result.value);
    useEffect(() => { const timer=setInterval(() => setNow(Date.now()),1000); return () => clearInterval(timer); },[]);
    useEffect(() => {
        if (operation.job?.kind !== 'scan-project-inventory' || operation.job.state !== 'succeeded') { return; }
        const value=matchingInventory(operation.job.result,projectId,bridge.device);
        if (value && requestScope === scope) { setResult({value,jobId:operation.job.id,scope}); }
        else { operation.setError('Поиск относится к другой папке или содержит неподдерживаемые данные. Выполните поиск заново.'); }
    },[operation.job?.id,operation.job?.state,operation.job?.result,scope,requestScope]);
    const scan=async () => {
        if (blocker || locked || !bridge.device) { return; }
        const binding=projectBinding(bridge.device,projectId); if (!binding?.bindingId) { return; }
        setResult(undefined); setRequestScope(scope);
        await operation.submit({kind:'scan-project-inventory',deviceId:bridge.device.id,projectId,expectedBindingId:binding.bindingId});
    };
    return <Space direction="vertical" size={12} className="local-operation">
        <Typography.Paragraph>Поиск читает только выбранную папку проекта: скиллы, MCP и плагины OpenCode. Код не запускается, файлы не перемещаются. Другие папки и личный глобальный профиль не сканируются.</Typography.Paragraph>
        <Button disabled={!!blocker || locked} loading={locked} onClick={() => { void scan(); }}>Найти инструменты в папке проекта</Button>
        {blocker && <Alert type="info" showIcon message={blocker} />}
        {result && !current && <Alert type="warning" showIcon message="Папка, подключение или файлы проекта изменились после поиска. Выполните поиск заново." />}
        {result && current && <>
            <Typography.Text type="secondary">Проверено: {new Date(result.value.checkedAt).toLocaleString('ru-RU')} · найдено {result.value.entries.length}</Typography.Text>
            {!result.value.complete && <Alert type="warning" showIcon message="Поиск выполнен не полностью" description="Лимит или ошибка чтения могли скрыть часть записей. Принятие отключено до полного поиска." />}
            {!!result.value.issues.length && <Typography.Text type="secondary">{result.value.issues.map(value => inventoryReasonLabels[value]).join('; ')}</Typography.Text>}
            {expired && <Alert type="warning" showIcon message="Результат поиска устарел. Выполните поиск заново перед принятием." />}
            {result.value.entries.length ? <List size="small" rowKey="candidateId" dataSource={result.value.entries} pagination={result.value.entries.length>20 ? {pageSize:20,size:'small'} : false}
                renderItem={entry => <List.Item><div className="local-installations__item">
                    <div className="local-installations__summary"><Typography.Text code className="local-operation__hash">{entry.path}</Typography.Text>
                        <Space wrap><Tag>{kinds[entry.kind]}</Tag><Tag>{states[entry.state]}</Tag></Space>
                        <Typography.Text type="secondary">{inventoryReasonLabels[entry.reason]}</Typography.Text>
                    </div>
                    {canManage && entry.state === 'unmanaged' && entry.kind !== 'unknown' && <Button size="small" disabled={!!adoptBlocker || !!adoptionCandidateBlocker(result.value,entry) || locked}
                        title={adoptBlocker || adoptionCandidateBlocker(result.value,entry) || undefined} onClick={() => setSelected({entry,report:result})}>Принять под управление</Button>}
                </div></List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="В папке проекта инструменты не найдены" />}
        </>}
        {operation.job && <Alert role="status" showIcon type={operation.job.state === 'failed' ? 'error' : 'info'} message={operation.job.message} />}
        {operation.error && <Alert role="alert" type="error" showIcon message={operation.error} />}
        {selected && <AdoptInstallationModal key={selected.report.jobId+selected.entry.candidateId} bridge={bridge} canManage={canManage} inventory={selected.report.value}
            inventoryJobId={selected.report.jobId} scope={selected.report.scope} entry={selected.entry} catalog={catalog} onClose={() => setSelected(undefined)} />}
    </Space>;
}
