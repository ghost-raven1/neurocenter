import {Alert,Button,Checkbox,Collapse,Empty,Input,Select,Space,Typography} from 'antd';
import {useRef,useState} from 'react';
import type {useBridge} from '../McpBridge/useBridge';
import {bridgeApi} from '../McpBridge/api';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {roleLevel} from '../UserBlock/roles';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {errorMessage} from '../../common/utils/errorMessage';
import {methodLabels,WORKFLOW_INPUT_MAX_BYTES} from './model';
import {useAgentMethodWorkflow} from './useAgentMethodWorkflow';
import {WorkflowResult} from './WorkflowResult';
import {WorkflowAgentSelect} from './WorkflowAgentSelect';
import {workflowAgentIssue,type WorkflowAgentCatalog} from './agentSelection';
import './AgentMethods.less';

interface Props {projectId:string;canManage:boolean;bridge:ReturnType<typeof useBridge>;onSetupRuntime?:()=>void;
    agentCatalog:WorkflowAgentCatalog|null;agentsLoading:boolean;agentsError:string;onReloadAgents:()=>Promise<unknown>;}

/** The project keeps task input and durable history even when a method or local executor is unavailable. */
export function AgentMethodWorkflow({projectId,canManage,bridge,onSetupRuntime,agentCatalog,agentsLoading,agentsError,onReloadAgents}:Props):JSX.Element{
    const availability=useFeatureAvailability('agent_method_workflows'),agentAvailability=useFeatureAvailability('project_agent_workflows'),value=useAgentMethodWorkflow(projectId),{captureOwner}=useAuthRequestOwner();
    const [selection,setSelection]=useState<string>(),[actionError,setActionError]=useState(''),[cancelling,setCancelling]=useState(false);
    const acting=useRef(false),device=bridge.device;
    const binding=device?.report.bindings?.find(item=>item.projectId===projectId&&item.valid!==false);
    const target=device&&binding?.bindingId&&binding.instanceId?{deviceId:device.id,expectedBindingId:binding.bindingId,expectedInstanceId:binding.instanceId}:undefined;
    const jobs=bridge.jobs.filter(job=>job.projectId===projectId&&job.kind==='run-agent-method-workflow');
    const active=jobs.some(job=>['queued','running','reconciling'].includes(job.state));
    const selected=jobs.find(job=>job.id===selection)||jobs.find(job=>job.id===value.accepted?.id)||value.accepted||jobs[0];
    const reason=!canManage?'Запуск доступен администратору проекта.':!bridge.devicesReady?bridge.errors.devices||'Перечитайте состояние компьютера.'
        :!device?'Выберите подключённый компьютер.':!device.online?'Компьютер не в сети. Подключите мост и обновите состояние.'
            :roleLevel(device.role)<3?'Переподключите мост с ролью администратора проекта.':!target?'Свяжите папку проекта на выбранном компьютере.'
                :device.report.platform==='win32'?'Выберите компьютер с macOS или Linux: выполнение методик на Windows пока недоступно.'
                    :!device.report.capabilities?.includes('agent-method-workflow-v1')?'Обновите мост для выполнения BMAD/OpenSpec.'
                    :!bridge.jobsReady?bridge.errors.jobs||'Дождитесь загрузки истории заданий.':'';
    const disabled=value.busy||!!value.draft.pending||!!value.storageError;
    const chosenAgent=agentCatalog?.assignments.find(item=>item.agentId===value.draft.agentId);
    const selectedAgentReason=value.draft.agentId?(!agentAvailability.enabled?agentAvailability.reason
        :agentsLoading?'Дождитесь проверки агентов проекта.':agentsError?'Обновите список агентов проекта перед запуском.'
            :!agentCatalog?.revision?'Ревизия агентов проекта не подтверждена. Обновите список.'
                :workflowAgentIssue(chosenAgent,agentCatalog)||(!device?.report.capabilities?.includes('agent-method-selected-agent-v1')?'Обновите мост для запуска выбранного агента.':''))
        :agentAvailability.enabled?'Выберите агента проекта для полного цикла.':'';
    const selectedReplay=!!value.draft.pending?.workflow.agentId;
    const replayAgentReason=selectedReplay?(!agentAvailability.enabled?agentAvailability.reason
        :!device?.report.capabilities?.includes('agent-method-selected-agent-v1')?'Обновите мост для выбранного агента.':''):'';
    const inputBytes=new TextEncoder().encode(value.draft.instruction).length,tooLong=inputBytes>WORKFLOW_INPUT_MAX_BYTES;
    const cancel=async():Promise<void>=>{
        if(!selected||acting.current)return;acting.current=true;const owns=captureOwner();setCancelling(true);setActionError('');
        try{await bridgeApi.cancel(selected.id);if(owns())await bridge.reload();}catch(cause){if(owns())setActionError(errorMessage(cause,'Не удалось подтвердить отмену. Перечитайте состояние.'));}
        finally{acting.current=false;if(owns())setCancelling(false);}
    };
    return <Collapse className="agent-methods"><Collapse.Panel key="workflow" header="BMAD / OpenSpec · задача через локальный мост"><Space direction="vertical" className="agent-methods__body">
        <Typography.Paragraph>Требования, код и проверки выполняются в привязанной папке через OpenCode. Используются подготовленные BMAD или OpenSpec и настроенная модель компьютера.</Typography.Paragraph>
        {!availability.enabled&&<Alert type="info" showIcon message={availability.reason} description="История, проверка отправки и отмена принятых задач доступны."/>}
        {reason&&<Alert type="info" showIcon message={reason} action={<Button onClick={()=>{void bridge.reload();}}>Обновить подключение</Button>}/>}
        <WorkflowAgentSelect catalog={agentCatalog} loading={agentsLoading} error={agentsError} enabled={agentAvailability.enabled} reason={agentAvailability.reason}
            selected={value.draft.agentId} disabled={disabled} onChange={agentId=>value.update({agentId})} onReload={onReloadAgents}/>
        {!!value.draft.agentId&&agentAvailability.enabled&&selectedAgentReason&&<Alert type="warning" showIcon message={selectedAgentReason}
            action={<Button disabled={agentsLoading} onClick={()=>{void onReloadAgents();}}>Обновить агентов</Button>}/>}
        <label>Методика<Select aria-label="Методика задачи" value={value.draft.method} disabled={disabled} options={Object.entries(methodLabels).map(([id,label])=>({value:id,label}))} onChange={method=>value.update({method})}/></label>
        <label>Задача<Input.TextArea aria-label="Задача методики" rows={3} maxLength={16384} status={tooLong?'error':undefined} value={value.draft.instruction} disabled={disabled} onChange={event=>value.update({instruction:event.target.value})} placeholder="Какой результат нужен в этом проекте?"/></label>
        {tooLong&&<Alert type="warning" showIcon message={`Задача занимает ${inputBytes} байт. Перед отправкой сократите её до ${WORKFLOW_INPUT_MAX_BYTES} байт; черновик сохранён.`}/>}
        <Checkbox.Group aria-label="Команды проверки" value={value.draft.checks} disabled={disabled} options={[{value:'typecheck',label:'npm run typecheck'},{value:'test',label:'npm test'},{value:'check',label:'npm run check'}]} onChange={checks=>value.update({checks:checks.map(String)})}/>
        <Typography.Text type="secondary">Компьютер: {device?.name||'не выбран'} · папка: {binding?.folderName||'не связана'}. Файлы проекта читаются на момент запуска.</Typography.Text>
        {value.storageError&&<Alert type="warning" showIcon message={value.storageError} action={value.damaged?<Button disabled={!bridge.jobsReady||active||value.busy} onClick={value.clearDamagedCopy}>Очистить локальную копию после просмотра истории</Button>:<Button disabled={value.busy} onClick={value.retrySave}>Повторить сохранение ввода</Button>}/>}
        {(value.error||actionError)&&<Alert type="warning" showIcon message={value.error||actionError}/>}
        {value.draft.pending?<Alert type="warning" showIcon message="Проверяем принятие задачи" description="Сохранённый запрос повторяется только с прежним ключом и прежней папкой. Новая отправка заблокирована." action={<Space wrap>
            <Button loading={value.busy} onClick={()=>{void value.recover().then(()=>bridge.reload());}}>Проверить отправку</Button>
            {value.canReplay&&<Button disabled={value.busy||!availability.enabled||!!reason||!!replayAgentReason} onClick={()=>{void value.replay().then(()=>bridge.reload());}}>Повторить тот же запрос</Button>}
            {value.canDiscard&&<Button disabled={value.busy||!!reason||!!value.storageError} onClick={value.discardRejected}>Вернуться к выбору агента и папки</Button>}
        </Space>}/>:<Button type="primary" loading={value.busy} disabled={!availability.enabled||!!reason||!!selectedAgentReason||active||!!value.storageError||tooLong||!value.draft.instruction.trim()||!value.draft.checks.length}
            onClick={()=>{if(target&&!selectedAgentReason)void value.start(target,value.draft.agentId?agentCatalog?.revision??undefined:undefined).then(()=>bridge.reload());}}>Выполнить задачу</Button>}
        {bridge.errors.jobs&&<Alert type="warning" showIcon message="История заданий не обновилась" description={bridge.errors.jobs} action={<Button onClick={()=>{void bridge.reload();}}>Повторить</Button>}/>}
        {jobs.length>0&&<Select aria-label="История задач методик" value={selected?.id} options={jobs.map(job=>({value:job.id,label:(job.agent?`${job.agent.slug} · v${job.agent.version}`:'Прежний запуск')+' · '+(job.method?methodLabels[job.method]:'Задача')+' · '+new Date(job.createdAt).toLocaleString('ru-RU')+' · '+job.state}))} onChange={setSelection}/>}
        {selected?<><WorkflowResult job={selected} agentCatalog={agentsLoading||agentsError?null:agentCatalog} onSetupRuntime={onSetupRuntime}/>{['queued','running','reconciling'].includes(selected.state)&&<Button loading={cancelling} onClick={()=>{void cancel();}}>Отменить задание</Button>}</>:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Заданий методик в проекте пока нет."/>}
    </Space></Collapse.Panel></Collapse>;
}
