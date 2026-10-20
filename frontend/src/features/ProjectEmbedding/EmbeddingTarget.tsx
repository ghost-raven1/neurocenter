import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useBridge} from '../McpBridge/useBridge';
import {Alert,Select,Space,Typography} from 'antd';
import {embeddingInstallations} from './connection';
import {embeddingInstallationKey,useEmbeddingInstallation} from './useEmbeddingInstallation';
import {sha} from './model';
import {uuid} from '../McpBridge/operationHelpers';
import type {IReindexConnectionTarget} from './reindex';
import {useState} from 'react';

/** A model intent captures exactly the computer/installation visible to the user. */
export function useEmbeddingTarget(projectId:string|undefined){
    const [mode,setMode]=useState<'server'|'computer'>('computer');
    const bridge=useBridge(!!projectId),{scope}=useAuthRequestOwner(),device=bridge.device;
    const binding=device?.report.bindings?.find(value=>value.projectId===projectId&&value.valid!==false);
    const choices=projectId?embeddingInstallations(bridge.installations,device,projectId,bridge.jobs).filter(item=>item.hostedEmbedding?.reindexSupported):[];
    const ready=bridge.devicesReady&&bridge.jobsReady&&bridge.installationsReady;
    const installation=useEmbeddingInstallation(JSON.stringify([scope,projectId,device?.id,device?.report.root,binding?.bindingId,binding?.instanceId]),choices,ready);
    const item=installation.item;
    const reason=!ready?'Дождитесь актуального списка компьютеров и установок.':!device?'Выберите компьютер для локального OpenCodeRAG.'
        :!device.report.capabilities?.includes('hosted-rag-reindex-v1')||!device.report.capabilities?.includes('hosted-rag-grants-v1')||!device.report.capabilities?.includes('hosted-rag-profile-values-v1')?'Обновите мост для подключения модели и переиндексации одним действием.'
        :!binding||!sha(binding.bindingId)||!uuid(binding.instanceId)?'Свяжите папку проекта с выбранным компьютером.'
        :!installation.eligible||!item?'Выберите проверенную установку OpenCodeRAG.':'';
    const value:IReindexConnectionTarget|undefined=mode==='computer'&&!reason&&item&&device&&binding?{deviceId:device.id,assetId:item.assetId,assetKind:item.assetKind as 'mcp'|'plugin',version:item.version,expectedManifest:item.manifest,expectedBindingId:binding.bindingId!,expectedInstanceId:binding.instanceId!}:undefined;
    return {bridge,device,binding,item,choices,installation,reason,value,mode,setMode,blocked:mode==='computer'&&!value};
}
export function EmbeddingTargetFields({target,disabled=false}:{target:ReturnType<typeof useEmbeddingTarget>;disabled?:boolean}){
    return <Space direction="vertical" size={8} style={{width:'100%'}}>
        <Typography.Text strong>Куда подключить модель</Typography.Text>
        <Select aria-label="Область подключения модели" value={target.mode} disabled={disabled} onChange={target.setMode} options={[{value:'computer',label:'Сервер и OpenCodeRAG на компьютере'},{value:'server',label:'Только серверная база знаний'}]}/>
        {target.mode==='computer'&&<Select aria-label="Компьютер для новой модели" value={target.device?.id} placeholder="Выберите компьютер" disabled={disabled} onChange={target.bridge.choose} options={target.bridge.devices.map(value=>({value:value.id,label:value.name}))}/>}
        {target.mode==='computer'&&target.choices.length>1&&<Select aria-label="Установка для новой модели" value={target.item&&embeddingInstallationKey(target.item)} placeholder="Выберите установку OpenCodeRAG" disabled={disabled} onChange={target.installation.choose} options={target.choices.map(value=>({value:embeddingInstallationKey(value),label:`${value.name} · ${value.assetKind==='mcp'?'MCP':'плагин'} · ${value.version}`}))}/>}
        {target.mode==='server'?<Typography.Text type="secondary">Подключение изменит серверную базу знаний проекта.</Typography.Text>:target.value?<Typography.Text type="secondary">Модель подключится к выбранной установке, локальный индекс перестроится и синхронизируется с сервером. Код отправляется провайдеру модели через Нейроцентр.</Typography.Text>:<Alert type="info" showIcon message={target.reason}/>}
        {target.value&&target.device?.online===false&&<Alert type="info" showIcon message="Компьютер не в сети. Подключение продолжится из очереди, когда мост появится на связи."/>}
    </Space>;
}
