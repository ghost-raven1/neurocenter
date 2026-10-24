import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {api,hub,readState,type Credentials} from '../../bridge/state.js';

export const updateCleanup=createRequire(import.meta.url)(fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../../../../services/shared/bridge-update-cleanup.cjs':'../../shared/bridge-update-cleanup.cjs',import.meta.url))) as typeof import('../../../../../services/shared/bridge-update-cleanup.cjs');

/** Offline or disabled maintenance leaves backups intact and never blocks the worker. */
export async function cleanupInstalledBridge(policy:import('../../../../../services/shared/runtime-cache-policy.cjs').BridgeUpdateCleanupPolicy) {
    if(!policy.enabled)return;
    const installRoot=fileURLToPath(new URL('../../../',import.meta.url));
    const owner=path.join(installRoot,updateCleanup.OWNER_FILE);
    const fs=await import('node:fs/promises');
    if(!await fs.lstat(owner).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))return;
    const site=hub(),deviceId=(await readState<Credentials>('credentials'))?.deviceId;
    if(!deviceId)return;
    const beforeDelete=async()=>{
        const {readBridgeCleanupPolicy}=await import('./policy-store.js');
        const current=await readBridgeCleanupPolicy();
        if(hub()!==site||(await readState<Credentials>('credentials'))?.deviceId!==deviceId||JSON.stringify(current)!==JSON.stringify(policy))throw new Error('Настройки или подключение изменились; копия сохранена.');
        const grant=await api<{ok:boolean}>('worker/update-cleanup/authorize',{});
        if(grant?.ok!==true||hub()!==site||(await readState<Credentials>('credentials'))?.deviceId!==deviceId||JSON.stringify(await readBridgeCleanupPolicy())!==JSON.stringify(policy))throw new Error('Очистка обновлений не разрешена.');
    };
    return updateCleanup.cleanupSuccessfulBackups({installRoot,policy,beforeDelete});
}
