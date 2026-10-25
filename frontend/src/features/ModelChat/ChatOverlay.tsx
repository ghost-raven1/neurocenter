import {Alert,Button,Empty,Modal,Radio,Select,Spin,Typography} from 'antd';
import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import {useHistory} from 'react-router-dom';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAvailableProjects} from '../../modules/Projects/useAvailableProjects';
import type {IProjectSummary} from '../../core/api/interfaces';
import type {RootState} from '../../store';
import {modelCatalogApi} from '../ModelCatalog/api';
import {useModelCatalog} from '../ModelCatalog/useModelCatalog';
import type {ICatalogModel} from '../ModelCatalog/types';
import {projectRoleLevel} from '../UserBlock/roles';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {modelChatApi} from './api';
import {ChatWorkspace} from './ChatWorkspace';
import {ConversationList} from './ConversationList';
import {modelChatUnavailableReason} from './model';
import {useChatIndex} from './useChatIndex';
import type {IChatLaunch} from './chatNavigation';
import type {IModelChatConversation,IModelChatDetail} from './types';
import './ModelChat.less';

const ProjectChatWorkspace=lazy(()=>import('../ProjectChat/ProjectChatWorkspace').then(value=>({default:value.ProjectChatWorkspace})));
const modeControls=(team:boolean,onChange:(team:boolean)=>void)=><Radio.Group aria-label="Режим чата" value={team?'team':'personal'} onChange={event=>onChange(event.target.value==='team')} optionType="button" buttonStyle="solid" options={[{label:'Команда проекта',value:'team'},{label:'Личные диалоги',value:'personal'}]}/>;
interface ScopeProps {projectId?:string;projects:IProjectSummary[];projectsLoading:boolean;initialGroup?:boolean;onTeam:()=>void;onProject:(id:string|undefined)=>void;onClose:()=>void;}

/** A saved dialogue fixes its model; choosing another model starts a fresh private dialogue. */
function ChatScope({projectId,projects,projectsLoading,initialGroup,onTeam,onProject,onClose}:ScopeProps):JSX.Element {
    const user=useSelector((state:RootState)=>state.userBlock.user),history=useHistory(),{captureOwner}=useAuthRequestOwner();
    const canUse=!!user&&(projectId?projectRoleLevel(user,projectId)>=2:user.activeRole==='Главный админ');
    const models=useModelCatalog(projectId),index=useChatIndex(projectId,canUse);
    const [selection,setSelection]=useState<{model:ICatalogModel;detail?:IModelChatDetail;group?:boolean;key:number}>();
    const [opening,setOpening]=useState(false),[openError,setOpenError]=useState('');
    const sequence=useRef(0),request=useRef<AbortController>();
    useEffect(()=>()=>{request.current?.abort();},[]);
    const project=projects.find(value=>value.id===projectId),name=project?.name;
    const assigned=new Set(models.catalog?.assignedModelIds??[]);
    const available=models.catalog?.items.filter(model=>!modelChatUnavailableReason(model,canUse,!!projectId,assigned.has(model.id)))??[];
    const selectModel=(id:string):void=>{const model=available.find(value=>value.id===id);if(!model||models.loading||models.error)return;request.current?.abort();setOpenError('');setSelection({model,group:!selection&&!!initialGroup,key:++sequence.current});};
    const openConversation=async(conversation:IModelChatConversation):Promise<void>=>{
        request.current?.abort();const controller=new AbortController();request.current=controller;const owns=captureOwner();setOpening(true);setOpenError('');
        try{const [detail,model]=await Promise.all([modelChatApi.read(conversation.id,controller.signal),modelCatalogApi.get(conversation.modelId)]);
            if(!owns()||controller.signal.aborted)return;
            if(detail.conversation.modelId!==model.id||detail.conversation.projectId!==(projectId??null))throw new Error('Диалог относится к другому проекту. Обновите список.');
            setSelection({model,detail,key:++sequence.current});
        }catch(cause){if(owns()&&!controller.signal.aborted)setOpenError(errorMessage(cause,'Диалог сейчас недоступен. История не изменена.'));}
        finally{if(request.current===controller){request.current=undefined;if(owns())setOpening(false);}}
    };
    const controls=(change:(action:()=>void)=>void)=><div className="model-chat__workspace-controls">
        {modeControls(false,()=>change(onTeam))}
        <label>Проект<Select aria-label="Проект чата" value={projectId??''} placeholder="Выберите проект" showSearch optionFilterProp="label" loading={projectsLoading} disabled={opening}
            options={[{value:'',label:user?.activeRole==='Главный админ'?'Без проекта':'Выберите проект',disabled:user?.activeRole!=='Главный админ'},...projects.filter(value=>projectRoleLevel(user,value.id)>=2).map(value=>({value:value.id,label:value.name})),...(projectId&&!project?[{value:projectId,label:'Текущий проект'}]:[])]}
            onChange={value=>change(()=>{request.current?.abort();onProject(value||undefined);})}/></label>
        <label>Модель нового диалога<Select aria-label="Модель чата" placeholder="Выберите модель" value={selection?.model.id} loading={models.loading} disabled={!canUse||models.loading||!!models.error||opening} showSearch optionFilterProp="label"
            options={available.map(model=>({value:model.id,label:model.name}))} onChange={value=>change(()=>selectModel(value))}/></label>
        <Button disabled={opening} onClick={()=>change(()=>{onClose();history.push('/store?tab=models'+(projectId?'&p='+encodeURIComponent(projectId):''));})}>Подключить модель</Button>
        {(openError||models.error)&&<Alert className="model-chat__workspace-error" type="error" showIcon message={openError||models.error} action={models.error?<Button size="small" onClick={()=>{void models.refresh();}}>Повторить</Button>:undefined}/>}
        {opening&&<span role="status" className="model-chat__workspace-opening"><Spin size="small"/> Открываем диалог…</span>}
    </div>;
    const currentModel=selection&&(models.catalog?.items.find(value=>value.id===selection.model.id)??selection.model);
    if(selection&&currentModel)return <ChatWorkspace key={selection.key} model={currentModel} projectId={projectId} projectName={name} onClose={()=>{request.current?.abort();onClose();}}
        unavailableReason={modelChatUnavailableReason(currentModel,canUse,!!projectId,assigned.has(currentModel.id))}
        navigation={{items:index.items,loading:index.loading,opening,error:index.error,initialDetail:selection.detail,initialGroup:selection.group,controls,onSelect:value=>{void openConversation(value);},onRefresh:()=>{void index.refresh();},onChanged:index.changed}}/>;
    return <Modal open centered width={1280} className="model-chat model-chat_global" title={<div className="model-chat__title">Чат<Typography.Text type="secondary">Личные диалоги с моделями и агентами проекта</Typography.Text></div>} onCancel={()=>{request.current?.abort();onClose();}} footer={null} destroyOnClose>
        {controls(action=>action())}<div className="model-chat__layout model-chat__layout_empty"><aside className="model-chat__sidebar"><ConversationList items={index.items} disabled={opening} newDisabled={!canUse||models.loading||!!models.error||!available.length} loading={index.loading} onSelect={id=>{const item=index.items.find(value=>value.id===id);if(item)void openConversation(item);}} onNew={()=>{const model=available[0];if(model)selectModel(model.id);}} onRefresh={()=>{void index.refresh();}}/>{index.error&&<Alert type="error" showIcon message={index.error}/>}</aside>
            <main className="model-chat__main model-chat__welcome"><Empty description={!canUse?'Выберите проект с доступом разработчика или администратора.':models.loading?'Загружаем модели…':!available.length?'В этом контексте нет готовой модели для чата. Подключите модель или проверьте её API в каталоге.':'Выберите модель или откройте сохранённый диалог. Участников можно добавить в настройках разговора.'}/></main></div>
    </Modal>;
}

/** Scope lives for the overlay lifetime, independently from navigation behind it. */
export default function ChatOverlay({projectId:initialProject,group,team:initialTeam,onClose}:IChatLaunch&{onClose:()=>void}):JSX.Element {
    const {scope}=useAuthRequestOwner(),projects=useAvailableProjects();
    const [projectId,setProjectId]=useState(initialProject);
    const [team,setTeam]=useState(!!initialTeam);
    const [teamConfiguration,setTeamConfiguration]=useState(!initialProject);
    const user=useSelector((state:RootState)=>state.userBlock.user);
    const canonical=projects.projects.find(value=>value.id===projectId||value.name===projectId)?.id??projectId;
    useEffect(()=>{if(projects.ready&&canonical!==projectId)setProjectId(canonical);},[projects.ready,canonical,projectId]);
    if(projectId&&(!projects.ready||canonical!==projectId))return <Modal open centered width={1280} title="Чат" footer={null} onCancel={onClose}>{projects.error?<Alert type="error" message={projects.error} action={<Button onClick={()=>{void projects.refresh();}}>Повторить</Button>}/>:<Spin tip="Проверяем доступные проекты…"/>}</Modal>;
    if(team)return <Modal open centered width={1280} className="model-chat model-chat_global model-chat_workspace project-chat-modal" title={<div className="model-chat__title">Чат<Typography.Text type="secondary">{projects.projects.find(project=>project.id===projectId)?.name ? `Проект «${projects.projects.find(project=>project.id===projectId)?.name}»` : 'Команда проекта'}</Typography.Text></div>} footer={null} onCancel={onClose} destroyOnClose>
        <div className={'model-chat__configuration'+(!teamConfiguration?' model-chat__configuration_collapsed':'')}>
            <div className="model-chat__configuration-summary"><Button type="text" size="small" aria-label="Настройки командного чата: проект и режим" aria-expanded={teamConfiguration} aria-controls="project-chat-configuration" onClick={()=>setTeamConfiguration(!teamConfiguration)}>Настройки <span aria-hidden="true">{teamConfiguration?'▴':'▾'}</span></Button><Typography.Text type="secondary" className="model-chat__configuration-scope">Команда проекта</Typography.Text></div>
            <div id="project-chat-configuration"><div className="model-chat__workspace-controls">{modeControls(true,setTeam)}<label>Проект<Select aria-label="Проект командного чата" value={projectId} placeholder="Выберите проект" loading={projects.loading} showSearch optionFilterProp="label"
                options={projects.projects.filter(project=>projectRoleLevel(user,project.id)>=1).map(project=>({value:project.id,label:project.name}))} onChange={setProjectId}/></label></div></div>
        </div>
        {projectId?<Suspense fallback={<Spin tip="Открываем команду…"/>}><ProjectChatWorkspace key={JSON.stringify([scope,projectId])} projectId={projectId} projectName={projects.projects.find(project=>project.id===projectId)?.name}/></Suspense>:<Empty description="Выберите проект для общей переписки с участниками и агентами."/>}
    </Modal>;
    return <ChatScope key={JSON.stringify([scope,projectId])} projectId={projectId} projects={projects.projects} projectsLoading={projects.loading} initialGroup={group} onTeam={()=>setTeam(true)} onProject={setProjectId} onClose={onClose}/>;
}
