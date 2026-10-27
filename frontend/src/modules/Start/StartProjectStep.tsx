import {ArrowRightOutlined} from '@ant-design/icons';
import {Alert,Button,Select,Skeleton,Space,Typography} from 'antd';
import {useSelector} from 'react-redux';
import {useHistory} from 'react-router-dom';
import {BridgeConnection} from '../../features/McpBridge/BridgeConnection';
import {sha,uuid} from '../../features/McpBridge/operationHelpers';
import {connectionBlocker} from '../../features/McpBridge/readiness';
import {useBridge} from '../../features/McpBridge/useBridge';
import {projectRoleLevel} from '../../features/UserBlock/roles';
import type {RootState} from '../../store';
import {projectBindingUrl} from '../Projects/projectNavigation';

interface ProjectChoice {id:string;name:string}
interface StartProjectStepProps {
    projects:ProjectChoice[];ready:boolean;loading:boolean;error:string;requestedProject:string|null;
    selectedProject?:ProjectChoice;refresh:()=>Promise<void>;onSelect:(id:string)=>void;onBack:()=>void;
}

/** A completed job is not proof: only the selected computer's current verified folder report confirms this step. */
export function StartProjectStep({projects,ready,loading,error,requestedProject,selectedProject,refresh,onSelect,onBack}:StartProjectStepProps){
    const bridge=useBridge(),history=useHistory(),user=useSelector((state:RootState)=>state.userBlock.user);
    const project=ready&&!error?projects.find(item=>item.id===selectedProject?.id):undefined;
    const {device}=bridge;
    const checked=bridge.devicesReady&&!bridge.errors.devices&&!!device&&bridge.devices.some(item=>item.id===device.id);
    const bindings=checked&&project?device!.report.bindings?.filter(item=>item.projectId===project.id)??[]:[];
    const confirmed=bindings.filter(item=>item.valid===true&&item.identityStatus==='verified'&&sha(item.bindingId)&&uuid(item.instanceId)&&!item.error&&!!item.folderName?.trim());
    const bound=confirmed.length>0,canManage=!!project&&projectRoleLevel(user,project.id)>=2;
    const blocker=!canManage?'Для изменения проекта нужна роль разработчика или администратора.'
        :connectionBlocker(device)||device?.report.rootError
        ||(confirmed.length>1?'У проекта несколько подтверждённых папок на этом компьютере. Проверьте нужную привязку на странице «Проекты» перед установкой.':'')
        ||(bindings.length!==confirmed.length?'Есть папки с неподтверждённой привязкой. Проверьте их на странице «Проекты».':'');
    const catalog=<Button type={bound?'primary':'default'} disabled={!project} onClick={()=>{if(project)history.push(`/store?p=${encodeURIComponent(project.name)}`);}}>Подобрать инструменты <ArrowRightOutlined/></Button>;
    const bind=<Button type={bound?'default':'primary'} disabled={!project||!canManage} onClick={()=>{if(project&&canManage)history.push(projectBindingUrl(project.id));}}>{bound?'Связать другую папку':'Выбрать папку и связать проект'} <ArrowRightOutlined/></Button>;
    return <>
        <Typography.Title level={3}>{bound?'Папка и проект связаны':'Свяжите папку с проектом'}</Typography.Title>
        <Typography.Paragraph type="secondary">{bound?'Привязка выбранного проекта подтверждена отчётом компьютера. Инструменты можно выбрать в каталоге проекта.':'Выберите серверный проект. Затем укажите его папку на своём компьютере. Названия папки и проекта могут отличаться.'}</Typography.Paragraph>
        {error&&<Alert className="start__project-notice" type="error" showIcon message="Не удалось загрузить проекты" description={error} action={<Button size="small" onClick={()=>{void refresh();}}>Повторить</Button>}/>}
        {ready&&!error&&projects.length===0&&<Alert className="start__project-notice" type="info" showIcon message="Нет доступных проектов" description="Откройте «Мои проекты», чтобы создать проект или проверить доступ к существующему." action={<Button onClick={()=>history.push('/projects')}>Мои проекты</Button>}/>}
        {ready&&!error&&projects.length>0&&requestedProject&&!project&&<Alert className="start__project-notice" type="warning" showIcon message="Проект недоступен" description="Он удалён или у вас нет доступа. Выберите другой проект из списка."/>}
        {loading&&!ready?<Skeleton active paragraph={{rows:2}}/>:<Space direction="vertical" size={16} style={{width:'100%'}}>
            <Select aria-label="Проект для настройки" showSearch optionFilterProp="label" placeholder="Выберите проект" value={project?.id} onChange={onSelect} disabled={!ready||!!error} style={{width:'100%',maxWidth:420}} options={projects.map(item=>({value:item.id,label:item.name}))} notFoundContent={error?'Список проектов недоступен':'Сначала создайте или подключите проект'}/>
            {project&&<>
                <BridgeConnection bridge={bridge} projectId={project.id} compact/>
                {bound?<Alert type={blocker?'warning':'success'} showIcon message={confirmed.length===1?'Папка связана с проектом':'Папки связаны с проектом'} description={<Space direction="vertical" size={8} style={{width:'100%',overflowWrap:'anywhere'}}>
                    <Typography.Text>{project.name} · {device!.name}</Typography.Text>
                    <ul style={{margin:0,paddingInlineStart:20}}>{bindings.map((item,index)=><li key={`${item.bindingId??'unverified'}:${index}`}><Typography.Text code>{item.folderName||'Имя папки недоступно'}</Typography.Text>{!confirmed.includes(item)&&' — привязка не подтверждена'}</li>)}</ul>
                    {blocker&&<Typography.Text>{blocker}</Typography.Text>}
                </Space>}/>:!checked?<Alert type="info" showIcon message="Статус папки пока не подтверждён" description={bridge.errors.devices||(!device?(bridge.devices.length?'Выберите компьютер, на котором находится папка проекта.':'Подключите компьютер на предыдущем этапе.'):'Дождитесь актуального ответа компьютера или проверьте привязку снова.')}/>
                    :bindings.length>0?<Alert type="warning" showIcon message="Подтвердите привязку папки заново" description="Текущий экземпляр папки не подтверждён. Откройте «Проекты» и повторите привязку. Файлы и история сохраняются."/>
                    :<Typography.Text type="secondary">На выбранном компьютере папка этого проекта пока не связана.</Typography.Text>}
                <Button loading={bridge.loading} onClick={()=>{void bridge.reload();}}>Проверить привязку</Button>
            </>}
            <Space wrap>{bound?catalog:bind}{bound?bind:catalog}</Space>
            {!bound&&<Typography.Text type="secondary">Инструменты можно выбрать в каталоге проекта. Для установки понадобится связанная папка.</Typography.Text>}
        </Space>}
        <Button style={{marginTop:16}} onClick={onBack}>Назад</Button>
    </>;
}
