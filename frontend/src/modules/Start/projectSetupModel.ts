import type {IProjectAsset} from '../../core/api/interfaces';
import type {IStoreApp} from '../../features/Catalog/types';
import type {useBridge} from '../../features/McpBridge/useBridge';
import {sha,uuid} from '../../features/McpBridge/operationHelpers';
import {mergeProjectCatalog} from '../Store/projectCatalogSnapshots';

/** Historical computer/folder and pairing links share the primary connection stage. */
export function unifiedSetupStep(search:string):number {
    const params=new URLSearchParams(search);
    if(params.get('setup')!=='1'&&(params.has('connect')||params.get('addComputer')==='1'))return 1;
    if(!params.has('step')&&(params.has('connect')||params.get('addComputer')==='1'))return 1;
    const value=Number(params.get('step')??0);
    if(params.get('setup')!=='1'&&value===2)return 1;
    return Number.isInteger(value)&&value>=0&&value<=3?value:0;
}

/** Only one fresh, verified folder on the explicitly selected computer may receive project setup. */
export function setupBinding(bridge:ReturnType<typeof useBridge>,projectId:string|undefined){
    if(!projectId||!bridge.devicesReady||bridge.errors.devices||!bridge.device?.online||bridge.device.report.rootError||!bridge.devices.some(item=>item.id===bridge.device!.id))return;
    const rows=bridge.device.report.bindings?.filter(item=>item.projectId===projectId)??[];
    if(rows.length!==1)return;
    const row=rows[0];
    return row.valid===true&&row.identityStatus==='verified'&&sha(row.bindingId)&&uuid(row.instanceId)&&!row.error&&row.folderName?.trim()?row:undefined;
}

/** Unresolved project pins remain visible and blocked; the global catalog never fills their place. */
export function setupProjectAssets(refs:readonly IProjectAsset[]):IStoreApp[]{
    const snapshots=mergeProjectCatalog([],refs);
    return refs.map(ref=>{
        const snapshot=snapshots.find(item=>item.id===ref.assetId&&item.kind===ref.assetKind);
        if(snapshot&&snapshot.version===ref.version&&sha(ref.manifest))return snapshot;
        return {id:ref.assetId,kind:ref.assetKind,name:ref.assetId,description:'',version:ref.version??0,tags:[],origin:'project',
            pinError:ref.pinError||'Версия назначения не подтверждена. Закрепите проверенную версию в каталоге проекта.'};
    });
}
