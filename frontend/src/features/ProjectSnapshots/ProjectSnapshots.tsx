import {useEffect,useRef} from 'react';
import {useSelector} from 'react-redux';
import {Alert,Button,Checkbox,Empty,InputNumber,Modal,Select,Skeleton,Space,Tag,Typography} from 'antd';
import type {RootState} from '../../store';
import {formatDate} from '../../common/utils/format';
import {projectRoleLevel} from '../UserBlock/roles';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useBridge} from '../McpBridge/useBridge';
import {projectSnapshotsApi} from './api';
import {SnapshotCard} from './SnapshotCard';
import {SnapshotIntentStatus} from './SnapshotIntentStatus';
import {snapshotCaptureTarget} from './snapshotReadiness';
import {useProjectSnapshots} from './useProjectSnapshots';
import {useSnapshotIntent} from './useSnapshotIntent';
import {snapshotPending,type ProjectSnapshot,type SnapshotIntent} from './types';
import './ProjectSnapshots.less';

/** Full, signed server images and release profiles are independent from installed local runtimes. */
export function ProjectSnapshots({projectId,onChanged}:{projectId:string;onChanged?:()=>void}){
    const user=useSelector((state:RootState)=>state.userBlock.user),{scope,captureOwner}=useAuthRequestOwner();
    const snapshots=useProjectSnapshots(projectId),bridge=useBridge(),canWrite=projectRoleLevel(user,projectId)>=3;
    const callback=useRef(onChanged);callback.current=onChanged;
    const intent=useSnapshotIntent(user?.email??'',projectId,canWrite&&snapshots.ready,()=>{void snapshots.refresh();callback.current?.();});
    const confirmation=useRef<{destroy():void}>();
    useEffect(()=>()=>{confirmation.current?.destroy();confirmation.current=undefined;},[scope,projectId]);
    const data=snapshots.data,project=data?.project;
    const blocked=!snapshots.ready||!canWrite||intent.loading||intent.busy||intent.blocked||!!intent.intent;
    const target=snapshotCaptureTarget(projectId,bridge.device,bridge.devicesReady&&!bridge.errors.devices&&bridge.devices.some(item=>item.id===bridge.device?.id));
    const pending=data?.snapshots.some(snapshotPending)??false;
    const createReason=!canWrite?'Для публикации и изменения снимков нужна роль администратора проекта.'
        :!snapshots.ready?'Сначала обновите сведения о снимках.'
        :!data?.capabilities.available?data?.capabilities.reason||'Публикация снимков сейчас недоступна.'
        :target.reason|| (pending?'Дождитесь завершения текущей публикации или отмените её.':'');
    const head=project&&Number.isSafeInteger(project.headRevision)?{expectedHeadId:project.head?.snapshotId??null,expectedHeadRevision:project.headRevision}:undefined;
    const confirm=(kind:'activate'|'rollback'|'delete'|'cancel'|'release',snapshot:ProjectSnapshot)=>{
        if(blocked||!project||!head||confirmation.current)return;
        const owns=captureOwner(),requestKey=crypto.randomUUID(),originalScope=scope;let gracePeriodHours=24,moveHead=false;
        const titles={activate:'Сделать снимок текущим на сервере?',rollback:'Откатить серверный снимок?',delete:'Удалить снимок?',cancel:'Отменить публикацию снимка?',release:'Выпустить релизный профиль?'};
        const content=kind==='delete'?<Space direction="vertical"><Typography.Text>Текущие снимки и снимки из профилей защищены от удаления. Байты будут очищены после периода ожидания.</Typography.Text><label>Период ожидания, часов <InputNumber aria-label="Период ожидания удаления" min={1} max={720} defaultValue={24} onChange={value=>{gracePeriodHours=value??24;}}/></label></Space>
            :kind==='release'?<Space direction="vertical"><Typography.Text>Профиль закрепит этот проверенный снимок и текущие точные версии инструментов проекта. Он не устанавливает их в открытой сессии OpenCode.</Typography.Text><Checkbox onChange={event=>{moveHead=event.target.checked;}}>Одновременно сделать снимок текущим на сервере</Checkbox></Space>
            :<Typography.Text>{kind==='cancel'?'Сервер закроет приём публикации. Неполный снимок не станет текущим.':'Изменится текущий снимок на сервере. Локальная база и открытая сессия OpenCode от этого не переключаются.'}</Typography.Text>;
        const dialog=Modal.confirm({title:titles[kind],content,okText:kind==='delete'?'Удалить':kind==='release'?'Выпустить':'Подтвердить',cancelText:'Отмена',okButtonProps:{danger:kind==='delete'},afterClose:()=>{if(confirmation.current===dialog)confirmation.current=undefined;},onOk:async()=>{
            if(!owns()||originalScope!==scope)return;
            let next:SnapshotIntent;
            if(kind==='release')next={projectId,kind,input:{requestKey,snapshotId:snapshot.snapshotId,expectedProfileId:project.activeProfileId,expectedProfileRevision:project.activeProfileRevision,...moveHead?{moveHead:head}:{}}};
            else if(kind==='delete')next={projectId,kind,snapshotId:snapshot.snapshotId,input:{requestKey,expectedManifest:snapshot.manifestSha256,gracePeriodHours}};
            else if(kind==='cancel')next={projectId,kind,snapshotId:snapshot.snapshotId,input:{requestKey}};
            else next={projectId,kind,snapshotId:snapshot.snapshotId,input:{requestKey,...head}};
            await intent.submit(next);
        }});confirmation.current=dialog;
    };
    return <Space direction="vertical" size={16} className="project-snapshots">
        <Space wrap className="project-snapshots__heading"><div><Typography.Title level={4}>Снимки проекта</Typography.Title><Typography.Text type="secondary">Полные образы LanceDB с проверкой файлов и подписью. Текущий снимок и релизный профиль хранятся на сервере.</Typography.Text></div><Button loading={snapshots.loading} onClick={()=>{void snapshots.refresh();void bridge.reload();}}>Обновить</Button></Space>
        <SnapshotIntentStatus state={intent} canWrite={canWrite}/>
        {snapshots.error&&<Alert type="error" showIcon message="Снимки не обновлены" description={snapshots.error}/>}
        {!canWrite&&<Alert type="info" showIcon message="Доступен просмотр снимков" description="Публиковать снимки, переключать текущий снимок и выпускать профили может администратор проекта."/>}
        <div className="project-snapshots__capture"><Space direction="vertical" size={12} style={{width:'100%'}}>
            <Typography.Text strong>Создать снимок с компьютера</Typography.Text>
            <Select aria-label="Компьютер для снимка" placeholder="Выберите компьютер" value={bridge.device?.id} disabled={!bridge.devicesReady||intent.busy||!!intent.intent} style={{width:'100%',maxWidth:440}} onChange={bridge.choose} options={bridge.devices.map(device=>({value:device.id,label:`${device.name} · ${device.online?'На связи':'Не в сети'}`}))}/>
            {target.folderName&&<Typography.Text type="secondary">Папка: {target.folderName}</Typography.Text>}
            {createReason&&<Typography.Text type="secondary">{createReason}</Typography.Text>}
            <Button type="primary" loading={intent.busy&&intent.intent?.kind==='create'} disabled={blocked||!!createReason||!head} onClick={()=>{
                if(!bridge.device||!target.bindingId||!head||createReason)return;
                void intent.submit({projectId,kind:'create',input:{requestKey:crypto.randomUUID(),deviceId:bridge.device.id,expectedBindingId:target.bindingId,...head}});
            }}>Создать снимок</Button>
        </Space></div>
        {snapshots.loading&&!data?<Skeleton active paragraph={{rows:4}}/>:data&&<>
            {data.snapshots.length===0?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Снимков пока нет"/>:<div className="project-snapshots__list">{data.snapshots.map(snapshot=><SnapshotCard key={snapshot.snapshotId} snapshot={snapshot} projectId={projectId} canWrite={canWrite} blocked={blocked||!head} hasHead={!!project?.head} onAction={confirm}/>)}</div>}
            <Typography.Title level={5}>Релизные профили</Typography.Title>
            {data.profiles.length===0?<Typography.Text type="secondary">Выпустите профиль из проверенного снимка: он закрепит снимок и текущие версии инструментов.</Typography.Text>:data.profiles.map(profile=><div className="project-snapshots__profile" key={profile.profileId}>
                <Space wrap><Typography.Text strong>Профиль {profile.revision}</Typography.Text>{profile.isActive&&<Tag color="blue">Активный</Tag>}<Typography.Text type="secondary">{formatDate(profile.createdAt)} · скиллов: {profile.skillPins.length}</Typography.Text></Space>
                <Typography.Text code className="project-snapshots__identity">Снимок: {profile.snapshotId}</Typography.Text>
                <Button href={projectSnapshotsApi.profileUrl(projectId,profile.profileId)} download={`release-profile-${profile.profileId}.json`}>Скачать профиль и подпись</Button>
            </div>)}
        </>}
    </Space>;
}
