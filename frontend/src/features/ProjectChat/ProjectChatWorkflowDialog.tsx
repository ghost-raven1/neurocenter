import {Alert,Modal,Typography} from 'antd';
import {useState} from 'react';
import {useBridge} from '../McpBridge/useBridge';
import {BridgeConnection} from '../McpBridge/BridgeConnection';
import {useAgentCatalog} from '../AgentCatalog/useAgentCatalog';
import {AgentMethodWorkflow} from '../AgentMethods/AgentMethodWorkflow';
import {ProjectProviderSetup} from '../OpenCodeProviders/ProjectProviderSetup';
import type {ProjectChatMessage} from './types';

/** Explicit opening mounts personal bridge data; the source owns a separate durable method draft. */
export function ProjectChatWorkflowDialog({projectId,roomId,message,canManage,onClose,onRefresh}:{projectId:string;roomId:string;message:ProjectChatMessage;canManage:boolean;onClose:()=>void;onRefresh:()=>Promise<unknown>}):JSX.Element{
    const bridge=useBridge(),agents=useAgentCatalog(projectId),[setup,setSetup]=useState(false);
    return <Modal open title="Выполнить задачу из сообщения" footer={null} width={860} onCancel={onClose} destroyOnClose>
        <Alert type="info" showIcon message="Задача и безопасный результат видны участникам этого диалога" description="Запуск выполняется на вашем компьютере. Личная очередь, настройки модели и журналы не публикуются."/>
        <details><summary>Исходное сообщение</summary><Typography.Paragraph className="project-chat__workflow-source">{message.content}</Typography.Paragraph></details>
        <BridgeConnection bridge={bridge} compact showReadinessNotice={false}/>
        <AgentMethodWorkflow projectId={projectId} canManage={canManage} bridge={bridge} agentCatalog={agents.catalog} agentsLoading={agents.loading} agentsError={agents.error} onReloadAgents={agents.refresh}
            origin={{roomId,messageId:message.id}} initialInstruction={message.content} linkedJobIds={message.methodWorkflows?.map(item=>item.jobId)} onAccepted={onRefresh} onSetupRuntime={canManage?()=>setSetup(true):undefined}/>
        {setup&&<ProjectProviderSetup projectId={projectId} bridge={bridge} canManage={canManage} onClose={()=>setSetup(false)}/>}
    </Modal>;
}
