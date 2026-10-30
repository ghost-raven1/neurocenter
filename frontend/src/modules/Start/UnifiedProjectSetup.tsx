import {ArrowRightOutlined,RocketOutlined} from '@ant-design/icons';
import {Alert,Button,Card,Modal,Select,Space,Steps,Tabs,Typography,message} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import {useHistory,useLocation} from 'react-router-dom';
import type {RootState} from '../../store';
import {PageHeading} from '../../common/components/PageHeading';
import {useAuthRequestOwner} from '../../features/UserBlock/useAuthRequestOwner';
import {isMainAdminRole,projectRoleLevel} from '../../features/UserBlock/roles';
import {useFeatureAvailability} from '../../features/FeatureFlags/FeatureAvailability';
import {useComputerEnvironment} from '../../features/ComputerSetup/ComputerEnvironment';
import {cliObservationPresentation} from '../../features/ComputerSetup/presentation';
import {WorkspaceBindingWizard} from '../../features/McpBridge/WorkspaceBindingWizard';
import {LocalInstallations} from '../../features/McpBridge/LocalInstallations';
import {AgentCatalog} from '../../features/AgentCatalog/AgentCatalog';
import {LocalProjectsFolder} from '../Projects/local/LocalProjectsFolder';
import {useAvailableProjects} from '../Projects/useAvailableProjects';
import {useProjectCatalog} from '../Store/useProjectCatalog';
import {BridgeConnectionStep} from './BridgeConnectionStep';
import {OpenCodeSetupStep} from './OpenCodeSetupStep';
import {LocalOpenCodeProvidersStep} from '../../features/LocalOpenCodeProviders/LocalOpenCodeProvidersStep';
import {OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION} from '@neurocenter/opencode-local-providers';
import {startQueryUrl,startSetupRequested} from './startQuery';
import {setupBinding,unifiedSetupStep} from './projectSetupModel';
import {StartProjectAssets} from './StartProjectAssets';
import './Start.less';

async function copyCommand(value:string){
    try{await navigator.clipboard.writeText(value);message.success('Команда скопирована. Выполните её на нужном компьютере.');}
    catch{message.error('Не удалось скопировать команду. Выделите её и скопируйте вручную.');}
}

/** A single entry composes existing installers and project owners; navigation never certifies local execution. */
export default function UnifiedProjectSetup(){
    const history=useHistory(),location=useLocation(),availability=useFeatureAvailability('unified_project_setup');
    const {scope}=useAuthRequestOwner(),user=useSelector((state:RootState)=>state.userBlock.user),projects=useAvailableProjects();
    const {bridge,installer,cli}=useComputerEnvironment(),[bindingOpen,setBindingOpen]=useState<string>();
    const [helpOpen,setHelpOpen]=useState(false);
    const params=new URLSearchParams(location.search),opened=startSetupRequested(location.search),step=unifiedSetupStep(location.search);
    const requested=params.get('p'),project=projects.ready&&!projects.error?(projects.projects.find(item=>item.id===requested)??projects.projects.find(item=>item.name===requested)):undefined;
    const level=project?projectRoleLevel(user,project.id):0,isMain=!!user&&isMainAdminRole(user.activeRole);
    const binding=setupBinding(bridge,project?.id),enabled=availability.enabled;
    const focusRequested=useRef(false),stepPanel=useRef<HTMLDivElement>(null);
    useEffect(()=>{if(focusRequested.current&&opened){stepPanel.current?.focus();focusRequested.current=false;}},[opened,step]);
    const go=(next:number)=>{focusRequested.current=true;history.replace(startQueryUrl(location.search,{setup:true,step:next},location.hash));};
    const select=(id:string)=>{setBindingOpen(undefined);history.replace(startQueryUrl(location.search,{project:id},location.hash));};
    const sourceScope=JSON.stringify([scope,project?.id,bridge.device?.id]);
    const projectCatalog=useProjectCatalog(project?.id,scope);
    const assets=projectCatalog.ready&&!projectCatalog.error?projectCatalog.assets:[];
    const cliView=cliObservationPresentation(cli.state),checking=cli.state.busy||cli.state.reading||cliView.running||cliView.unknown;
    const inspect=!!bridge.device&&(checking||cliView.observation?.status==='installed');
    const computerReady=bridge.devicesReady&&!bridge.errors.devices&&!!bridge.device?.online&&!bridge.device.requiresReconnect;
    const observedVersion=cliView.observation?.status==='installed'?cliView.observation.version:undefined;
    const cliReady=computerReady&&!!observedVersion,providerNeedsSetup=!!observedVersion&&observedVersion!==OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION;
    const projectChoice=<Space direction="vertical" style={{width:'100%'}}>
        {projects.error&&<Alert type="error" showIcon message="Не удалось загрузить проекты" description={projects.error} action={<Button onClick={()=>{void projects.refresh();}}>Повторить загрузку проектов</Button>}/>}
        <Select aria-label="Проект единой установки" placeholder="Выберите проект" value={project?.id} disabled={!projects.ready||!!projects.error} loading={projects.loading} showSearch optionFilterProp="label"
            options={projects.projects.map(item=>({value:item.id,label:item.name}))} onChange={select} style={{width:'100%',maxWidth:460}}/>
        {requested&&projects.ready&&!projects.error&&!project&&<Alert type="warning" showIcon message="Выбранный проект недоступен. Выберите действующий проект."/>}
        {projects.ready&&!projects.error&&!projects.projects.length&&<Alert type="info" showIcon message="Сначала создайте проект или получите к нему доступ" action={<Button onClick={()=>history.push('/projects')}>Мои проекты</Button>}/>}
    </Space>;
    return <div className="start"><PageHeading title="Начало работы" description="Подключите мост и настройте проект по шагам." actions={<Space><Button onClick={()=>setHelpOpen(true)}>Помощь</Button><Button onClick={()=>history.push('/projects')}>Мои проекты</Button></Space>}/>
        <Card className="start__setup"><Space direction="vertical" size={20} style={{width:'100%'}}>
            <div><Typography.Title level={2}>Подготовьте компьютер и проект</Typography.Title><Typography.Paragraph>Мост → OpenCode → провайдеры → папка проекта → агенты и инструменты → проверка.</Typography.Paragraph></div>
            {!enabled&&<Alert type="info" showIcon message={availability.reason} description="Новые действия единого мастера выключены. Состояние, история и восстановление сохраняются."/>}
            {!opened?<Space wrap><Button type="primary" size="large" icon={<RocketOutlined/>} loading={enabled&&inspect&&checking}
                disabled={enabled&&inspect&&(checking||!cli.canStart||cli.state.denied)}
                onClick={()=>{if(enabled&&inspect){void cli.controller.start();}else go(0);}}>{enabled?inspect?'Проверить OpenCode':'Начать настройку':'Посмотреть состояние и настройку'}</Button>
                {enabled&&inspect&&<Button type="link" onClick={()=>go(computerReady?1:0)}>Настроить проект</Button>}</Space>:<>
                <Typography.Text strong>Шаг {step+1} из 6</Typography.Text>
                <div role="group" aria-label="Этапы основной настройки" onKeyDown={event=>{
                    if((event.key==='Enter'||event.key===' ')&&event.target instanceof HTMLElement&&event.target.getAttribute('role')==='button'){
                        event.preventDefault();event.target.click();
                    }
                }}><Steps current={step} size="small" responsive={false} onChange={go} items={[
                    {title:'Мост',status:computerReady?'finish':step===0?'process':'wait'},
                    {title:'OpenCode',status:cliReady?'finish':step===1?'process':'wait'},
                    {title:'Провайдеры',status:step===2?'process':'wait'},
                    {title:'Папка проекта',status:binding?'finish':step===3?'process':'wait'},
                    {title:'Агенты и инструменты',status:step===4?'process':'wait'},
                    {title:'Проверка',status:step===5?'process':'wait'}]}/></div>
                <div className="start__step" ref={stepPanel} tabIndex={-1} aria-label={`Шаг ${step+1} основной настройки`} key={sourceScope+':'+step}>
                    {step===0&&<BridgeConnectionStep bridge={bridge} installer={installer} enabled={enabled} canManage={isMain} onCopy={value=>{void copyCommand(value);}} onContinue={()=>go(1)}/>}
                    {step===1&&<OpenCodeSetupStep enabled={enabled} onBridge={()=>go(0)} onContinue={()=>go(2)}/>}
                    {step===2&&<Space direction="vertical" size={16} style={{width:'100%'}}>
                        {!cliReady&&<Alert type="info" showIcon message="Сначала подтвердите OpenCode" action={<Button onClick={()=>go(1)}>К проверке OpenCode</Button>}/>}
                        <LocalOpenCodeProvidersStep bridge={bridge} enabled={enabled&&cliReady} cliVersion={cliReady?observedVersion:undefined} onContinue={()=>go(3)}/>
                    </Space>}
                    {step===3&&<Space direction="vertical" size={20} style={{width:'100%'}}>
                        {!cliReady&&<Alert type="warning" showIcon message="Сначала проверьте OpenCode на выбранном компьютере" action={<Button onClick={()=>go(1)}>К OpenCode</Button>}/>}
                        <section id="setup-project-folder"><Typography.Title level={3}>Проект и папка</Typography.Title>{projectChoice}
                            {enabled&&<LocalProjectsFolder bridge={bridge} project={null} setupProjectId={project?.id} canManage={cliReady&&level>=2} onClose={()=>undefined}/>}
                            {project&&<>
                                <Alert type={binding?'success':'info'} showIcon message={binding?`Папка подтверждена: ${binding.folderName}`:'Подтвердите папку выбранного проекта'} description={bridge.errors.devices||'Папка и компьютер определяются по актуальному отчёту моста.'}/>
                                <Button disabled={!enabled||!cliReady||level<2||!bridge.devicesReady||!bridge.jobsReady||!bridge.device?.online||!bridge.device.report.root} onClick={()=>setBindingOpen(sourceScope)}>{binding?'Проверить или изменить папку проекта':'Связать папку проекта'}</Button>
                            </>}
                        </section>
                        <Button type="primary" disabled={!project||!binding||!cliReady} onClick={()=>go(4)}>К агентам и инструментам <ArrowRightOutlined/></Button>
                    </Space>}
                    {step===4&&<Space direction="vertical" size={16} style={{width:'100%'}}>
                        {projectChoice}
                        {!binding&&<Alert type="warning" showIcon message="Точная папка ещё не подтверждена" action={<Button onClick={()=>go(3)}>К папке проекта</Button>}/>}
                        {project&&<Tabs defaultActiveKey="agents" items={[{key:'agents',label:'Агенты и модель',children:<AgentCatalog embedded projectId={project.id} projectName={project.name} bridge={bridge} canManage={enabled&&level>=3&&!!binding} isMain={enabled&&isMain}/>},
                            {key:'tools',label:'Скиллы, плагины и MCP',children:<StartProjectAssets projectId={project.id} projectName={project.name} bridge={bridge} enabled={enabled} canInstall={level>=2} canApprove={level>=3}/>} ]}/>}
                        <Button type="primary" disabled={!project||!binding} onClick={()=>go(5)}>Проверить окружение <ArrowRightOutlined/></Button>
                    </Space>}
                    {step===5&&<Space direction="vertical" size={16} style={{width:'100%'}}>
                        {projectChoice}<Typography.Title level={3}>Проверка окружения проекта</Typography.Title>
                        <Alert type={binding?'info':'warning'} showIcon message={binding?'Подключение и папка подтверждены. Проверьте каждый установленный инструмент.':'Готовность папки не подтверждена'} description="Результаты инструментов появятся ниже. Проверка ответа модели запускается отдельно."/>
                        {providerNeedsSetup&&<Alert type="warning" showIcon message="Провайдеры требуют отдельной проверки" description="Для этой версии OpenCode доступны только файлы прежнего формата. Настройте провайдеров в OpenCode; их действующая авторизация этим мастером не подтверждена." action={<Button onClick={()=>go(2)}>К провайдерам</Button>}/>}
                        <Button loading={bridge.loading} onClick={()=>{void bridge.reload();void projectCatalog.refresh();}}>Проверить актуальное состояние</Button>
                        {project&&<LocalInstallations bridge={bridge} projectId={project.id} canManage={enabled&&level>=2} canInspect={enabled&&level>=2} catalog={assets.map(item=>({id:item.assetId,kind:item.assetKind,name:item.assetId}))} approved={new Set(assets.map(item=>item.assetKind+':'+item.assetId))}/>}
                        {projectCatalog.error&&<Alert type="warning" showIcon message="Назначения инструментов не обновились" description={projectCatalog.error}/>}
                        <Button onClick={()=>go(4)}>Вернуться к агентам, модели и инструментам</Button>
                    </Space>}
                </div>
                <Space wrap>{step>0&&<Button onClick={()=>go(step-1)}>Назад</Button>}<Button onClick={()=>history.replace(startQueryUrl(location.search,{setup:false,step:0,addComputer:false},location.hash))}>Свернуть мастер</Button></Space>
            </>}
        </Space></Card>
        <Modal open={helpOpen} title="Помощь с подключением" footer={null} onCancel={()=>setHelpOpen(false)} destroyOnClose>
            <Typography.Paragraph>Если установка моста прервалась, повторите только подключение. Установленный OpenCode и данные проекта сохраняются.</Typography.Paragraph>
            <Space direction="vertical"><Button onClick={()=>{setHelpOpen(false);go(0);}}>Открыть подключение моста</Button>
                <Button type="link" href="/help/opencode-install">Установка и проверка в Помощи</Button></Space>
        </Modal>
        {enabled&&bindingOpen===sourceScope&&project&&<WorkspaceBindingWizard key={sourceScope} bridge={bridge} project={project} canManage={cliReady&&level>=2} onClose={()=>{setBindingOpen(undefined);void bridge.reload();}}/>}
    </div>;
}
