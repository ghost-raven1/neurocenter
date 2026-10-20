import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {jobContext} from '../../bridge/state.js';
import {verify,type Package} from '../../bridge/package.js';
import {projectFolder,projectBindingId,projectInstanceId} from '../../bridge/workspace.js';
import {inspectInstallation} from '../../bridge/installation-inspection.js';
import {assertInspectionIdentity} from '../../bridge/inspection-identity.js';
import {safeTarget} from '../../bridge/workspace-paths.js';
import {readBoundedUtf8} from '../../bridge/read-bounded.js';
import {withWorkspaceIdentityLock} from '../../bridge/workspace-identity-state.js';
import {resolvePreparedRuntimeArtifact} from '../runtime-artifacts/cache.js';
import {packageEnvironment} from '../runtime-probe/profile.js';
import {ProbeScope} from '../runtime-probe/process.js';
import {readMcpConfiguration,parseLocalConfiguration} from '../local-configuration/index.js';
import {closeOwnRagUi} from '../rag-ui/index.js';
import {localRagUi} from '../rag-ui/contract.js';
import {locateStore} from '../../lib/store.js';
import {readRagProjectIdentity,verifiedRagProjectIdentity} from '../../lib/rag-project-identity.js';
import {openIndexSnapshot} from '../rag-index/snapshot.js';
import {assertIndexIdle} from '../rag-index/readiness.js';
import {reserveRestoreIndex} from '../rag-index/restore-lock.js';
import {commitRagRestore} from '../rag-index/restore-recovery.js';
import {restoreDirectoryProof,matchesRestoreProof} from '../rag-index/restore-proof.js';
import {rowFingerprint,indexSnapshotHash,embeddingSignature} from '../rag-index/contract.js';
import {exportRow} from '../rag-index/paths.js';
import {createEmptyIndex} from '../../lib/lancedb.js';
import type {IHostedConnectionTransaction,IHostedReindexResult} from './index.js';

/** A single selected installation builds in isolation; old data/config switch together under the existing journal. */
export async function reindexHostedRag(input:{projectId:string;bindingId:string;instanceId:string;pkg:Package},publication:IHostedConnectionTransaction,
    authorize:()=>Promise<void>,progress:(percent:number,message:string)=>Promise<unknown>):Promise<IHostedReindexResult>{
    const pkg=structuredClone(input.pkg);verify(pkg);
    if((pkg.config?.extra?.hostedEmbedding as {reindexSchemaVersion?:unknown}|undefined)?.reindexSchemaVersion!==1||!localRagUi(pkg))throw new Error('Обновите OpenCodeRAG для управляемой переиндексации.');
    const root=await projectFolder(input.projectId),identity=(await readRagProjectIdentity({project:root},root)).value;
    if(!verifiedRagProjectIdentity(identity,input.projectId)||identity.bindingId!==input.bindingId||identity.instanceId!==input.instanceId)throw new Error('Папка проекта изменилась.');
    const located=await locateStore(root,root,true),store=located.storePath;if(!store)throw new Error('Не определена папка индекса.');
    const boundary=async()=>{
        await authorize();if(await projectFolder(input.projectId)!==root||await projectBindingId(input.projectId)!==input.bindingId||await projectInstanceId(input.projectId)!==input.instanceId)throw new Error('Привязка проекта изменилась. Переиндексация остановлена.');
        await safeTarget(root,path.relative(root,store).split(path.sep).join('/'));
    };
    await boundary();const inspection=await inspectInstallation(input.projectId,pkg);assertInspectionIdentity(inspection,input.projectId,input.bindingId,pkg);
    if(inspection.state!=='checked'||inspection.status!=='synced')throw new Error('Проверьте файлы выбранной установки OpenCodeRAG.');
    const artifact=await resolvePreparedRuntimeArtifact(pkg);if(!artifact)throw new Error('Комплект OpenCodeRAG отсутствует. Обновите установку.');
    const cli={...pkg,config:{...pkg.config,extra:{...pkg.config?.extra,runtimeArtifacts:pkg.config!.extra!.runtimeArtifacts!.map(item=>({...item,entrypoint:'opencode-rag.mjs',executable:false}))}}};
    const managed=await resolvePreparedRuntimeArtifact(cli);if(!managed||managed.root!==artifact.root)throw new Error('Управляемая точка входа не закреплена в архиве.');
    let env=packageEnvironment(pkg,process.env);if(parseLocalConfiguration(pkg))env={...env,...(await readMcpConfiguration(input.projectId,pkg,undefined,authorize)).env};
    await closeOwnRagUi(input.projectId);await assertIndexIdle(store,true);
    const lock=await reserveRestoreIndex(root,store),before=await restoreDirectoryProof(store,lock.raw);
    let stage:string|undefined,previous:Awaited<ReturnType<typeof openIndexSnapshot>>|undefined;
    const scope=new ProbeScope(15*60*1000);let authorizationFailed=false;
    const guard=setInterval(()=>{void boundary().catch(()=>{authorizationFailed=true;scope.close();});},5000);guard.unref();
    try{
        try{await fs.lstat(path.join(store,'chunks.lance'));previous=await openIndexSnapshot(store);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        const parent=path.dirname(store);await safeTarget(root,path.relative(root,parent).split(path.sep).join('/'));stage=await fs.mkdtemp(path.join(parent,'.neurocenter-rag-restore-'));
        await progress(30,'Строим новый локальный индекс. Прежний индекс сохранён.');
        const execution=await scope.command(process.execPath,[managed.entrypoint,'reindex','--stage',stage],root,{...env,NEUROCENTER_RAG_REINDEX_CONTEXT:JSON.stringify(publication.embedding)},boundary,true);
        if(execution.code!==0||authorizationFailed)throw new Error('Локальная переиндексация не завершена. Прежний индекс и подключение сохранены.');
        let result:{complete?:unknown;dimension?:unknown;rowCount?:unknown};try{result=JSON.parse(execution.stdout.trim());}catch{throw new Error('OpenCodeRAG не подтвердил результат переиндексации.');}
        const profile=publication.embedding.profile;if(result.complete!==true||result.dimension!==profile.dimension||!Number.isSafeInteger(result.rowCount)||Number(result.rowCount)<0)throw new Error('OpenCodeRAG вернул неполный результат.');
        if(result.rowCount===0)await createEmptyIndex(stage,profile.dimension);
        const built=await openIndexSnapshot(stage),fingerprints:Record<string,string>=Object.create(null);
        try{
            if(built.dimension!==profile.dimension||built.rowCount!==result.rowCount)throw new Error('Размерность или число строк нового индекса не совпало.');
            for await(const raw of built.rows()){
                const row=await exportRow(raw,root);if(!row.embedding||row.embedding.length!==profile.dimension||!row.embedding.some(value=>Math.fround(value)!==0)||row.embedding.some(value=>!Number.isFinite(Math.fround(value)))||Object.hasOwn(fingerprints,row.id))throw new Error('Новый индекс содержит несовместимые векторы.');
                fingerprints[row.id]=rowFingerprint(row);
            }
        }finally{built.close();}
        const record=JSON.parse(await readBoundedUtf8(path.join(stage,'neurocenter-index-profile.json'),1024*1024));
        if(record.state!=='ready'||record.embeddingSignature!==embeddingSignature(profile,publication.embedding.baseUrl)||!isDeepStrictEqual(record.profile,profile))throw new Error('Происхождение нового индекса не подтверждено.');
        const snapshotHash=indexSnapshotHash(profile,fingerprints),readOverrides=()=>readBoundedUtf8(path.join(store,'runtime-overrides.json'),1024*1024).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
        const overrides=await readOverrides();if(overrides!==null)await fs.writeFile(path.join(stage,'runtime-overrides.json'),overrides);
        await lock.place(stage);
        await withWorkspaceIdentityLock(async()=>{
            await boundary();await lock.assert();await lock.assert(stage!);await previous?.assertCurrent();
            if(!before||!matchesRestoreProof(await restoreDirectoryProof(store,lock.raw),before))throw new Error('Исходный индекс изменился во время построения. Прежняя копия сохранена.');
            previous?.close();previous=undefined;
            try{await commitRagRestore({root,store,stage:stage!,lock:lock.raw,overrides,identity,...jobContext.getStore()?{deferCompletion:true as const}:{},privateConfiguration:{key:publication.key,before:publication.before,after:publication.after},
                result:{ok:true,applied:true,complete:true,remaining:0,fingerprintVersion:1,indexProfile:profile,snapshotHash,written:Number(result.rowCount),sourceCount:Number(result.rowCount),dimension:profile.dimension}});}
            catch(error){if((error as {restoreRecoveryPending?:boolean}).restoreRecoveryPending)stage=undefined;throw error;}
            stage=undefined;
        });
        await progress(85,'Новый локальный индекс проверен и подключён.');return {complete:true,rowCount:Number(result.rowCount),snapshotHash};
    }finally{clearInterval(guard);scope.close();previous?.close();try{await lock.release();}finally{if(stage)await fs.rm(stage,{recursive:true,force:true});}}
}
