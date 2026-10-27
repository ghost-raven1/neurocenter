import {Alert,Button,Empty,List,Space,Tag,Typography} from 'antd';
import {useMemo} from 'react';
import {useAuthRequestOwner} from '../../features/UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../../features/FeatureFlags/FeatureAvailability';
import type {useBridge} from '../../features/McpBridge/useBridge';
import {installationBlocker} from '../../features/McpBridge/readiness';
import {currentInstallation,isPending,latestAssetJob} from '../../features/McpBridge/installationHelpers';
import {latestInstallationReport,pendingLocalJob} from '../../features/McpBridge/operationHelpers';
import {runtimeArtifactBlocker} from '../../features/McpBridge/runtimeArtifacts';
import {InstallationReadinessStatus} from '../../features/McpBridge/InstallationReadinessStatus';
import {useProjectCatalog} from '../Store/useProjectCatalog';
import {useInstallPlan} from '../Store/installPlans/useInstallPlan';
import {InstallPlanModal} from '../Store/installPlans/InstallPlanModal';
import {InstallPlanFailureModal} from '../Store/installPlans/InstallPlanFailureModal';
import {setupBinding,setupProjectAssets} from './projectSetupModel';

interface Props {projectId:string;projectName:string;bridge:ReturnType<typeof useBridge>;canInstall:boolean;canApprove:boolean;enabled:boolean;}

/** Project assignments use the same exact approval and installation owner as the catalog. */
export function StartProjectAssets({projectId,projectName,bridge,canInstall,canApprove,enabled}:Props){
    const {scope,captureOwner}=useAuthRequestOwner(),catalog=useProjectCatalog(projectId,scope),availability=useFeatureAvailability('tool_installation');
    const apps=useMemo(()=>setupProjectAssets(catalog.assets),[catalog.assets]);
    const binding=setupBinding(bridge,projectId),device=bridge.device;
    const target=(app:typeof apps[number])=>({projectId,deviceId:device?.id,bindingId:binding?.bindingId??null,assetId:app.id,assetKind:app.kind});
    const job=(app:typeof apps[number])=>latestAssetJob(bridge.jobs,target(app));
    const installed=(app:typeof apps[number])=>currentInstallation(bridge.installations,target(app));
    const reason=!enabled?'Единая настройка выключена. История установок доступна ниже.':!canInstall?'Для установки нужна роль разработчика в этом проекте.':!availability.enabled?availability.reason
        :installationBlocker(device)||(!binding?'Подтвердите точную папку проекта на предыдущем этапе.':'')
            ||(!bridge.jobsReady||!bridge.installationsReady?'Обновите очередь и установки выбранного компьютера.':'')
                ||(!catalog.ready||catalog.loading||catalog.error?'Дождитесь актуального каталога проекта.':'');
    const plans=useInstallPlan({scopeKey:JSON.stringify([scope,projectId,device?.id,binding?.bindingId,enabled,canInstall,canApprove,reason]),
        deviceId:device?.id,projectId,bindingId:binding?.bindingId,ready:!reason,canApprove:enabled&&canApprove,captureOwner,
        prepareCatalog:async(app,current)=>current()&&!!apps.find(item=>item.id===app.id&&item.kind===app.kind&&item.version===app.version&&!item.pinError),
        isPending:app=>isPending(job(app))||!!(installed(app)&&pendingLocalJob(bridge.jobs,installed(app)!)),
        planBlocker:plan=>runtimeArtifactBlocker(plan,device),reload:bridge.reload});
    return <Space direction="vertical" style={{width:'100%'}}>
        <Typography.Paragraph>Устанавливаются только инструменты, назначенные этому проекту. Точные файлы, версии и подключения показываются перед одобрением.</Typography.Paragraph>
        {catalog.error&&<Alert type="error" showIcon message="Каталог проекта не обновился" description={catalog.error} action={<Button onClick={()=>{void catalog.refresh();}}>Повторить загрузку инструментов</Button>}/>}
        {reason&&<Alert type="info" showIcon message={reason}/>}
        {!catalog.loading&&catalog.ready&&!apps.length&&<Empty description="Проекту пока не назначены скиллы, плагины или MCP. Добавьте нужный набор в каталоге проекта."/>}
        <List loading={catalog.loading} dataSource={apps} rowKey={item=>item.kind+':'+item.id} renderItem={app=>{
            const local=installed(app),pending=job(app),same=local?.version===app.version&&local.manifest===app.projectManifest;
            return <List.Item actions={[<Button key="install" loading={plans.busy===app.id} disabled={!!reason||!!app.pinError||!!plans.busy||isPending(pending)||!!(local&&pendingLocalJob(bridge.jobs,local))||same}
                onClick={()=>{void plans.install(app);}}>{same?'Установлено':local?'Подготовить обновление':'Установить'}</Button>]}>
                <Space direction="vertical" size={4}><Typography.Text strong>{app.name}</Typography.Text><Space><Tag>{app.kind==='skill'?'Скилл':app.kind==='mcp'?'MCP':'Плагин'}</Tag><Typography.Text type="secondary">{app.version?`Версия ${app.version}`:'Версия не подтверждена'}</Typography.Text></Space>
                    {app.pinError&&<Typography.Text type="danger">{app.pinError}</Typography.Text>}
                    {local&&<InstallationReadinessStatus item={latestInstallationReport(local,bridge.jobs)} jobs={bridge.jobs}/>}
                    {pending&&isPending(pending)&&<Typography.Text role="status">{pending.message}</Typography.Text>}
                </Space>
            </List.Item>;
        }}/>
        <Button onClick={()=>{void catalog.refresh();void bridge.reload();}}>Обновить инструменты и установки</Button>
        <InstallPlanModal plan={plans.review?.plan??null} name={plans.review?.app.name} projectName={projectName} canApprove={enabled&&canApprove} busy={!!plans.busy}
            installOnApprove={plans.review?.installOnApprove??false} installDisabled={plans.installDisabled} installBlocker={plans.installBlocker} onCancel={plans.cancel}
            onApprove={()=>{void plans.approve();}} onRevoke={()=>{void plans.revoke();}} onInstall={()=>{void plans.installReviewed();}}/>
        <InstallPlanFailureModal failure={plans.failure} busy={!!plans.busy} onCancel={plans.cancel} onRetry={()=>{void plans.retryFailure();}}/>
    </Space>;
}
