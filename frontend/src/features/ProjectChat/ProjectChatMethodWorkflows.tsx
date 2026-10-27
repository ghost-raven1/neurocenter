import {Alert,Button,Space,Tag,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {bridgeApi} from '../McpBridge/api';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {methodLabels,workflowAgentIdentity,workflowResult} from '../AgentMethods/model';
import {WorkflowResult} from '../AgentMethods/WorkflowResult';
import type {ProjectChatMethodWorkflow,ProjectChatMethodWorkflowHistory} from './types';
import {projectChatApi} from './api';

const states:Record<ProjectChatMethodWorkflow['state'],string>={queued:'В очереди',running:'Выполняется',reconciling:'Проверяем исход',succeeded:'Локальное выполнение завершено',failed:'Требует продолжения',cancelled:'Отменено'};

/** Room readers see pinned execution facts; only a fresh server grant exposes cancellation. */
export function ProjectChatMethodWorkflows({items,history,projectId,roomId,messageId,onRefresh}:{items:ProjectChatMethodWorkflow[];history?:ProjectChatMethodWorkflowHistory;projectId:string;roomId:string;messageId:string;onRefresh:()=>Promise<unknown>}):JSX.Element{
    const {captureOwner}=useAuthRequestOwner(),working=useRef(false);
    const [busy,setBusy]=useState<string>(),[error,setError]=useState('');
    const [loaded,setLoaded]=useState(items),[page,setPage]=useState(history),[loading,setLoading]=useState(false),[historyError,setHistoryError]=useState('');
    const paged=useRef(false),reading=useRef<AbortController>();
    const merge=(current:ProjectChatMethodWorkflow[],incoming:ProjectChatMethodWorkflow[])=>{const byId=new Map(current.map(item=>[item.jobId,item]));for(const item of incoming)byId.set(item.jobId,item);return [...byId.values()];};
    useEffect(()=>{setLoaded(previous=>merge(items,previous).map(item=>items.find(value=>value.jobId===item.jobId)??item));if(!paged.current)setPage(history);},[items,history]);
    useEffect(()=>()=>reading.current?.abort(),[]);
    const read=async(before?:string,append=false):Promise<void>=>{
        if(reading.current)return;const owns=captureOwner();if(!owns())return;const controller=new AbortController();reading.current=controller;setLoading(true);setHistoryError('');
        try{const value=await projectChatApi.workflows(projectId,messageId,before,controller.signal,roomId);if(owns()&&!controller.signal.aborted){setLoaded(previous=>merge(previous,value.items));if(append){paged.current=true;setPage({hasMore:value.hasMore,nextCursor:value.nextCursor});}}}
        catch(cause){if(owns()&&!controller.signal.aborted){setHistoryError(errorMessage(cause,'История задач не загрузилась. Уже открытые карточки сохранены.'));
            if([401,403,404].includes((cause as {response?:{status?:number}})?.response?.status??0))void onRefresh();}}
        finally{if(reading.current===controller)reading.current=undefined;if(owns()&&!controller.signal.aborted)setLoading(false);}
    };
    const refresh=async(item:ProjectChatMethodWorkflow):Promise<void>=>{await onRefresh();const index=loaded.findIndex(value=>value.jobId===item.jobId);await read(index>0?loaded[index-1].jobId:undefined);};
    const cancel=async(item:ProjectChatMethodWorkflow):Promise<void>=>{
        if(!item.canCancel||working.current)return;working.current=true;const owns=captureOwner();setBusy(item.jobId);setError('');
        try{await bridgeApi.cancel(item.jobId);if(owns())await refresh(item);}
        catch(cause){if(owns())setError(errorMessage(cause,'Отмена не подтверждена. Обновите состояние задачи.'));}
        finally{working.current=false;if(owns())setBusy(undefined);}
    };
    return <section className="project-chat__method-workflows" aria-label="Выполнение задач сообщения">
        {loaded.map(item=>{
            const agent=workflowAgentIdentity(item.agent),candidate=item.publicationState==='published'&&agent?workflowResult(item.result,agent):undefined;
            const result=candidate?.workflowId===item.workflowId&&candidate.method===item.method?candidate:undefined;
            return <div className="project-chat__method-workflow" key={item.jobId}>
                <Space wrap><Typography.Text strong>{methodLabels[item.method]||'Методика'}</Typography.Text><Typography.Text>{agent?`${agent.slug} · v${agent.version}`:'Исполнитель не подтверждён'}</Typography.Text>
                    <Tag>{states[item.state]}</Tag>{item.percent!==null&&Number.isFinite(item.percent)&&<Typography.Text type="secondary">{Math.min(100,Math.max(0,item.percent))}%</Typography.Text>}</Space>
                {item.publicationState==='withheld'?<Alert type="info" showIcon message="Результат не опубликован в диалоге" description="Локальный исход сохранён. Данные исполнения недоступны для публикации в этом диалоге."/>
                    :result?<><Typography.Paragraph>Проверки: {result.checks.filter(check=>check.state==='passed').length}/{result.checks.length} · {result.codeChanged?'Изменения кода подтверждены':'Изменения кода не подтверждены'}</Typography.Paragraph>
                        <details><summary>Результат и фактические проверки</summary><WorkflowResult job={{agent,state:item.state,result}}/></details></>
                        :<Typography.Paragraph type="secondary">{item.publicationState==='published'?'Результат исполнения не подтверждён. Перечитайте состояние задачи.':['queued','running','reconciling'].includes(item.state)?'Ожидаем публикацию проверяемого результата.':'Проверяемый результат пока не опубликован. Обновите состояние задачи.'}</Typography.Paragraph>}
                <Space wrap><Button size="small" disabled={loading} onClick={()=>{void refresh(item);}}>Обновить задачу</Button>
                    {item.canCancel&&['queued','running','reconciling'].includes(item.state)&&<Button size="small" loading={busy===item.jobId} disabled={!!busy} onClick={()=>{void cancel(item);}}>Отменить задачу методики</Button>}</Space>
            </div>;
        })}
        {page?.hasMore&&<Button size="small" loading={loading} disabled={loading||!page.nextCursor} onClick={()=>{void read(page.nextCursor??undefined,true);}}>Ещё задачи этого сообщения</Button>}
        {historyError&&<Alert type="warning" showIcon message={historyError}/>}
        {error&&<Alert type="warning" showIcon message={error}/>}
    </section>;
}
