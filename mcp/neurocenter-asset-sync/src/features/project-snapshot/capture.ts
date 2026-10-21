import fs from 'node:fs/promises';
import path from 'node:path';
import {locateStore} from '../../lib/store.js';
import {readRagProjectIdentity,verifiedRagProjectIdentity} from '../../lib/rag-project-identity.js';
import {ragStoreBoundary} from '../../lib/rag-store-boundary.js';
import {workspaceDirectory} from '../../bridge/workspace-paths.js';
import {assertIndexIdle} from '../rag-index/readiness.js';
import {reserveRestoreIndex} from '../rag-index/restore-lock.js';
import {captureImageFiles,imageTree} from './files.js';
import {openFullSdkSnapshot} from './sdk.js';
import {normalizeSnapshotManifest,snapshotCanonicalJson,snapshotManifestHash} from './contract.js';

export interface SnapshotCaptureInput {projectId:string;bindingId:string;snapshotId:string;snapshotProtocol:'project-snapshots-v1'}
const uuid=(value:string)=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

/** The source index is reserved, never rewritten; only complete .lance data enters the portable image. */
export async function captureProjectImage(root:string,input:SnapshotCaptureInput,authorize:()=>Promise<unknown>){
    if(!input||!uuid(input.snapshotId)||input.snapshotProtocol!=='project-snapshots-v1'||!input.projectId||!/^[a-f0-9]{64}$/.test(input.bindingId))throw new Error('Некорректная публикация полного снимка.');
    await authorize();const owner=await readRagProjectIdentity({project:root,createIfMissing:false},root);
    if(!verifiedRagProjectIdentity(owner.value,input.projectId)||owner.value.bindingId!==input.bindingId)throw new Error('Привязка папки проекта изменилась. Создайте новый снимок.');
    const workspace=await workspaceDirectory(root),located=await locateStore(root,root);
    if(!located.storePath)throw new Error('Локальная LanceDB не найдена. Создайте индекс перед публикацией.');
    const store=located.storePath,relative=path.relative(root,store).split(path.sep).join('/');
    if(!relative||relative.startsWith('../')||path.isAbsolute(relative))throw new Error('Снимок может читать только LanceDB внутри привязанной папки проекта.');
    const stat=await fs.lstat(store);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('LanceDB должна быть существующей обычной папкой.');
    const boundary=ragStoreBoundary(root,root,store),idle=await assertIndexIdle(store,true);
    const lock=await reserveRestoreIndex(root,store);let sdk:Awaited<ReturnType<typeof openFullSdkSnapshot>>|undefined;
    const checkpoint=async()=>{
        await authorize();const current=await readRagProjectIdentity({project:root,createIfMissing:false},root);
        if(!verifiedRagProjectIdentity(current.value,input.projectId,owner.value)||snapshotCanonicalJson((await workspaceDirectory(root)).physical)!==snapshotCanonicalJson(workspace.physical))throw new Error('Локальный экземпляр проекта изменился. Публикация остановлена.');
        await boundary();await lock.assert();if(await assertIndexIdle(store,true,lock.raw)!==idle)throw new Error('Состояние индекса изменилось во время публикации.');
    };
    try{
        await checkpoint();sdk=await openFullSdkSnapshot(store,checkpoint);const before=await imageTree(store,sdk.names);
        await sdk.validateRows();const image=await captureImageFiles(store,sdk.names,checkpoint);
        if(snapshotCanonicalJson(before)!==snapshotCanonicalJson(image.proof))throw new Error('Индекс изменился во время проверки SDK. Снимок не завершён.');
        const manifest=normalizeSnapshotManifest({format:'neurocenter.lancedb-snapshot',schemaVersion:1,sdkVersion:'0.29.0',tables:sdk.tables,files:image.files});
        if(Buffer.byteLength(snapshotCanonicalJson(manifest))>32*1024*1024)throw new Error('Опись снимка превышает 32 МиБ. Снимок не обрезан и не опубликован.');
        const assertCurrent=async()=>{await checkpoint();await sdk!.assertCurrent();await image.assertCurrent();await checkpoint();};
        await assertCurrent();return {manifest,manifestSha256:snapshotManifestHash(manifest),chunks:image.chunks,readChunk:image.readChunk,checkpoint,assertCurrent,
            async close(){try{await sdk?.close();}finally{await lock.release();}}};
    }catch(error){try{await sdk?.close();}finally{await lock.release();}throw error;}
}
