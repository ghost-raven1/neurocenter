import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useBridge} from '../McpBridge/useBridge';
import {Alert,Button,Select,Space,Typography} from 'antd';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {projectBindingUrl,projectRagCatalogUrl} from '../../modules/Projects/projectNavigation';
import {embeddingInstallations,pendingEmbeddingInspection} from './connection';
import {embeddingInstallationKey,useEmbeddingInstallation} from './useEmbeddingInstallation';
import {sha} from './model';
import {uuid} from '../McpBridge/operationHelpers';
import type {IReindexConnectionTarget} from './reindex';
import {useState} from 'react';

type TTargetBlocker='loading'|'computer'|'bridge'|'binding'|'installation'|'selection'|'inspection';

/** A model intent captures exactly the computer/installation visible to the user. */
export function useEmbeddingTarget(projectId:string|undefined){
    const [mode,setMode]=useState<'server'|'computer'>('computer');
    const bridge=useBridge(!!projectId),{scope}=useAuthRequestOwner(),device=bridge.device;
    const binding=device?.report.bindings?.find(value=>value.projectId===projectId&&value.valid!==false);
    const choices=projectId?embeddingInstallations(bridge.installations,device,projectId,bridge.jobs).filter(item=>item.hostedEmbedding?.reindexSupported):[];
    const ready=bridge.devicesReady&&bridge.jobsReady&&bridge.installationsReady;
    const installation=useEmbeddingInstallation(JSON.stringify([scope,projectId,device?.id,device?.report.root,binding?.bindingId,binding?.instanceId]),choices,ready);
    const item=installation.item;
    const inspection=projectId&&!choices.length?pendingEmbeddingInspection(bridge.installations,device,projectId,bridge.jobs,item):undefined;
    const blocker:TTargetBlocker|undefined=!ready?'loading':!device?'computer'
        :!device.report.capabilities?.includes('hosted-rag-reindex-v1')||!device.report.capabilities?.includes('hosted-rag-grants-v1')||!device.report.capabilities?.includes('hosted-rag-profile-values-v1')?'bridge'
        :!binding||!sha(binding.bindingId)||!uuid(binding.instanceId)?'binding'
        :!installation.eligible||!item?choices.length?'selection':inspection?'inspection':'installation':undefined;
    const reason=blocker?({loading:bridge.error||'Дождитесь актуального списка компьютеров и установок.',computer:'Выберите компьютер для локального OpenCodeRAG.',
        bridge:'Обновите мост для подключения модели и переиндексации одним действием.',binding:'Свяжите папку проекта с выбранным компьютером.',
        installation:'Установите OpenCodeRAG из каталога и проверьте его файлы в блоке «На этом компьютере». После этого выберите установку для подключения модели.',
        selection:'Выберите доступную проверенную установку OpenCodeRAG.',
        inspection:'OpenCodeRAG установлен. Проверяем файлы… Подключение модели станет доступно после успешной сверки.'})[blocker]:'';
    const value:IReindexConnectionTarget|undefined=mode==='computer'&&!reason&&item&&device&&binding?{deviceId:device.id,assetId:item.assetId,assetKind:item.assetKind as 'mcp'|'plugin',version:item.version,expectedManifest:item.manifest,expectedBindingId:binding.bindingId!,expectedInstanceId:binding.instanceId!}:undefined;
    return {projectId,bridge,device,binding,item,choices,installation,ready,blocker,reason,value,mode,setMode,blocked:mode==='computer'&&!value};
}
export function EmbeddingTargetFields({target,disabled=false,showTitle=true}:{target:ReturnType<typeof useEmbeddingTarget>;disabled?:boolean;showTitle?:boolean}){
    const options:Array<{value:string;label:string;disabled?:boolean}>=target.choices.map(value=>({value:embeddingInstallationKey(value),label:`${value.name} · ${value.assetKind==='mcp'?'MCP':'плагин'} · ${value.version}`}));
    if(target.item&&!target.installation.eligible)options.unshift({value:embeddingInstallationKey(target.item),label:`${target.item.name} · недоступна`,disabled:true});
    const recovery=<Space wrap>
        {target.blocker==='installation'&&target.projectId&&<FeatureButton features={['tool_installation']} href={projectRagCatalogUrl(target.projectId)} disabled={disabled}>Установить OpenCodeRAG</FeatureButton>}
        {target.blocker==='binding'&&target.projectId&&<Button href={projectBindingUrl(target.projectId)} disabled={disabled}>Связать папку проекта</Button>}
        {target.blocker==='bridge'&&<Button href="/start" disabled={disabled}>Обновить мост</Button>}
        {target.blocker==='computer'&&<Button href="/start" disabled={disabled}>Подключить компьютер</Button>}
        {target.blocker==='inspection'&&<Button href="/operations" disabled={disabled}>Ход проверки</Button>}
        {(target.blocker==='loading'||target.blocker==='installation'||target.blocker==='inspection')&&<Button loading={target.bridge.loading} disabled={disabled} onClick={()=>{void target.bridge.reload();}}>Обновить установки</Button>}
    </Space>;
    return <Space direction="vertical" size={8} style={{width:'100%'}}>
        {showTitle&&<Typography.Text strong>Куда подключить модель</Typography.Text>}
        <Select aria-label="Область подключения модели" value={target.mode} disabled={disabled} onChange={target.setMode} options={[{value:'computer',label:'Сервер и OpenCodeRAG на компьютере'},{value:'server',label:'Только серверная база знаний'}]}/>
        {target.mode==='computer'&&<Select aria-label="Компьютер для новой модели" value={target.device?.id} placeholder="Выберите компьютер" disabled={disabled} onChange={target.bridge.choose} options={target.bridge.devices.map(value=>({value:value.id,label:value.name}))}/>}
        {target.mode==='computer'&&(target.choices.length>1||target.item&&!target.installation.eligible)&&<Select aria-label="Установка для новой модели" value={target.item&&embeddingInstallationKey(target.item)} placeholder="Выберите установку OpenCodeRAG" disabled={disabled||!target.ready} onChange={target.installation.choose} options={options}/>}
        {target.mode==='server'?<Typography.Text type="secondary">Подключение изменит только серверную базу знаний проекта. Локальный индекс не создаётся: для индексации файлов на компьютере установите OpenCodeRAG и выберите «Сервер и OpenCodeRAG на компьютере».</Typography.Text>:target.value?<Typography.Text type="secondary">Модель подключится к выбранной установке, локальный индекс перестроится и синхронизируется с сервером. Код отправляется провайдеру модели через Нейроцентр.</Typography.Text>:<Alert type="info" showIcon message={target.reason}/>}
        {target.mode==='computer'&&!target.value&&recovery}
        {target.value&&target.device?.online===false&&<Alert type="info" showIcon message="Компьютер не в сети. Подключение продолжится из очереди, когда мост появится на связи."/>}
    </Space>;
}
