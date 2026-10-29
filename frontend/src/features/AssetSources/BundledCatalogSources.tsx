import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Card,Form,Input,Modal,Space,Tag,Typography} from 'antd';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useToolBuild} from '../../modules/Store/packaging/useToolBuild';
import {usePackagingPublication} from '../../modules/Store/packaging/usePackagingPublication';
import {PackagingPublicationPanel} from '../../modules/Store/packaging/PackagingPublicationPanel';
import {PackagingBuildStatus} from '../../modules/Store/packaging/PackagingBuildStatus';
import {BuildTargetChoice} from '../../modules/Store/packaging/BuildTargetChoice';
import {packagingPlatformLabels} from '../../modules/Store/packaging/platformLabels';
import type {IBundledSourcePlan} from './types';

/** Recipe selection reuses the existing durable build journal, cancellation and native publication CAS. */
export function BundledCatalogSources({plans,scope,blocked,onPublished,onImportArchive}:{plans:IBundledSourcePlan[];scope:string;blocked:boolean;onPublished:()=>void;onImportArchive:()=>void}):JSX.Element{
    const {captureOwner}=useAuthRequestOwner(),journalScope=scope+':bundled-catalog';
    const build=useToolBuild(journalScope),publication=usePackagingPublication(journalScope,captureOwner);
    const [open,setOpen]=useState(false),[plan,setPlan]=useState<IBundledSourcePlan>(),[name,setName]=useState(''),[targets,setTargets]=useState<string[]>();
    const observed=useRef<string>();
    useEffect(()=>{setOpen(false);setPlan(undefined);setName('');setTargets(undefined);observed.current=undefined;},[scope]);
    useEffect(()=>{
        if(!build.draft)return;const request=build.draft.request;publication.restore(request);setName(request.name);setTargets(request.targets);
        const source=request.source;if(source.type==='bundled')setPlan(plans.find(row=>row.id===source.id&&row.revision===source.revision));
    },[build.draft]);
    useEffect(()=>{if(build.job?.state==='SUCCEEDED'&&observed.current!==build.job.id){observed.current=build.job.id;onPublished();}},[build.job?.id,build.job?.state,onPublished]);
    const retained=!!build.draft||!!build.job||build.unresolved||build.cancelPending;
    const locked=build.active||build.recovering||build.recoveryBlocked||retained;
    const choose=(value:IBundledSourcePlan):void=>{
        if(blocked||locked||!captureOwner()())return;
        setPlan(value);setName(value.imported?.name||value.name);setTargets(undefined);setOpen(true);
        if(value.imported&&(value.kind==='mcp'||value.kind==='plugin'))void publication.select({catalogId:value.imported.id,kind:value.kind});else publication.clear();
    };
    const supported=Object.keys(packagingPlatformLabels).filter(target=>!plan?.id.includes('opencode-rag')||target!=='darwin-x64');
    const submit=():void=>{
        if(blocked||locked||!plan||!['mcp','plugin'].includes(plan.kind)||!captureOwner()()||publication.blocked||!name.trim()||targets?.length===0)return;
        void build.submit({kind:plan.kind as 'mcp'|'plugin',name:name.trim(),description:plan.description||plan.name,
            source:{type:'bundled',id:plan.id,revision:plan.revision},...(targets?{targets}:{}),
            ...(publication.selection?{publication:{catalogId:publication.selection.catalogId,expectedVersion:publication.selection.expectedVersion,expectedSourceHash:publication.selection.expectedSourceHash}}:{})});
    };
    const finish=async():Promise<void>=>{if(await build.reset()){setPlan(undefined);setName('');setTargets(undefined);publication.clear();setOpen(false);}};
    if(!plans.length&&!retained&&!build.recoveryBlocked)return <></>;
    return <section aria-label="Исходники текущей версии приложения">
        <Typography.Title level={3}>Исходники текущей версии</Typography.Title>
        <Typography.Paragraph type="secondary">Закреплённые рецепты приходят с обновлением приложения. Подготовьте пакет и проверьте результат перед установкой в проект.</Typography.Paragraph>
        {(retained||build.recoveryBlocked)&&<Button className="asset-sources__resume" onClick={()=>setOpen(true)}>Продолжить подготовку каталога</Button>}
        <div className="asset-sources__grid">{plans.map(value=><Card key={value.id} size="small" title={value.name} className="asset-sources__card">
            <div className="asset-sources__card-content"><Space wrap><Tag>{value.kind==='mcp'?'MCP':value.kind==='plugin'?'Плагин':value.kind==='model'?'Модель':'Мост компьютера'}</Tag><Typography.Text type="secondary" title={value.sourceRevision}>{value.sourceRevision==='application'?'Из исходников приложения':'Исходники '+value.sourceRevision.replace(/^(git-[a-f0-9]{8})[a-f0-9]{32}$/,'$1')}</Typography.Text></Space>
                <Typography.Paragraph>{value.description}</Typography.Paragraph>
                {value.imported&&<Typography.Text type="secondary">В каталоге: редакция {value.imported.version} · {value.imported.originVersion}</Typography.Text>}
            </div><div className="asset-sources__bundled-action">
                {value.catalogReady&&value.imported?<><Typography.Text>Пакет этой версии опубликован в каталоге</Typography.Text><Button href={'/store?'+new URLSearchParams({q:value.imported.name||value.name})}>Открыть в каталоге</Button></>:['prepared','local-project'].includes(value.delivery)?<FeatureButton features={['asset_sources','tool_builds','tool_catalog','tool_build_validation']} disabled={blocked||locked||value.imported?.archived||value.imported?.unavailable} onClick={()=>choose(value)}>{value.imported?'Подготовить обновление':'Подготовить пакет'}</FeatureButton>
                    :value.kind==='model'?<><Typography.Text type="secondary">Веса добавляются выбранным GGUF или локальным архивом.</Typography.Text><Button href="/store?tab=models">Открыть модели</Button></>
                    :value.kind==='bridge'?<Typography.Text type="secondary">Архив моста создаётся из текущей версии приложения.</Typography.Text>
                    :<><Typography.Text type="secondary">Для этой версии нужен выбранный локальный архив.</Typography.Text><FeatureButton features={['asset_sources']} disabled={blocked} onClick={()=>{if(captureOwner()())onImportArchive();}}>Импортировать архив</FeatureButton></>}
            </div>
        </Card>)}</div>
        <Modal open={open} title="Подготовка пакета каталога" onCancel={()=>setOpen(false)} footer={<Space wrap>
            <Button onClick={()=>setOpen(false)}>Скрыть</Button>
            {build.canCancel&&<Button danger loading={build.cancelling} onClick={()=>void build.cancel()}>Отменить сборку</Button>}
            {build.cancelPending&&<Button loading={build.cancelling} onClick={()=>void build.retryCancel()}>Повторить отмену</Button>}
            {build.canDetach&&<Button loading={build.archiving} onClick={()=>void build.detach()}>К другой подготовке</Button>}
            {build.unresolved&&!build.cancelPending&&<><Button onClick={build.recheck}>Проверить сохранённый запрос</Button><FeatureButton features={['asset_sources','tool_builds','tool_catalog','tool_build_validation']} disabled={blocked||!build.draft} onClick={()=>void build.retrySaved()}>Повторить сохранённый запрос</FeatureButton></>}
            {(build.job||build.cancelled)&&!build.active&&<Button onClick={()=>void finish()}>К списку исходников</Button>}
            {!retained&&<FeatureButton features={['asset_sources','tool_builds','tool_catalog','tool_build_validation']} type="primary" disabled={blocked||locked||!plan||publication.blocked||!name.trim()||targets?.length===0} onClick={submit}>Подготовить и опубликовать</FeatureButton>}
        </Space>}>
            {build.error&&<Alert type="error" showIcon message={build.error}/>}
            {build.recoveryBlocked&&<Button onClick={build.retryRecovery}>Повторить восстановление запроса</Button>}
            {retained?<PackagingBuildStatus job={build.job} name={build.draft?.request.name||name} active={open} cancelPending={build.cancelPending} cancelled={build.cancelled}/>:<>
                <Typography.Paragraph>{plan?.name} · {plan?.sourceRevision}</Typography.Paragraph>
                <PackagingPublicationPanel publication={publication} disabled={locked||blocked} onConfirm={()=>{const target=publication.confirm();if(target)setName(target.name);}}/>
                <Form layout="vertical"><Form.Item label="Название в каталоге"><Input value={name} disabled={locked||!!publication.target} onChange={event=>setName(event.target.value)}/></Form.Item>
                    <BuildTargetChoice value={targets} supported={supported} disabled={locked||blocked} onChange={setTargets}/></Form>
            </>}
            <Typography.Paragraph type="secondary">Публикация создаёт новую редакцию каталога. Обновление проекта и установка через его мост выполняются отдельно.</Typography.Paragraph>
            {build.archived.map(record=><Button key={record.requestKey} disabled={!build.canRestoreArchived} onClick={()=>void build.restoreArchived(record.requestKey)}>Вернуться к отмене: {record.name}</Button>)}
            {build.archiveError&&<Alert type="warning" showIcon message={build.archiveError} action={<Button onClick={build.retryRecovery}>Повторить восстановление</Button>}/>}
        </Modal>
    </section>;
}
