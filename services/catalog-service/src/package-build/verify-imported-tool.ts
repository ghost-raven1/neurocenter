import {ConflictException} from '@nestjs/common';
import {serializeAsset} from '@neurocenter/asset-contract';
import {createReadStream,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {AssetBlobStore} from '../asset-sources/asset-blob-store';
import type {IPreparedLocalAsset} from '../asset-sources/local-asset-ingest';
import {reserveCapacity} from '../../../shared/capacity.cjs';
import {assertToolSupplyLayout,toolRuntimePath,toolSourcePath} from '../../../shared/tool-supply-paths.cjs';
import {assertRuntimeCandidate,verifyBuildRuntime,type BuildRuntimeReport} from './build-runtime';
import {TOOL_IMPORT_TIMEOUT_MS} from '../../../shared/tool-import-deadline.cjs';

/** An unreaped verifier keeps its supply and capacity reserved for operator recovery. */
export class ToolImportCleanupPendingError extends ConflictException{
    constructor(readonly retainedStage:string){super('Очистка проверки не подтверждена, временная поставка удержана. Проверьте runner и повторите тот же запрос для проверки результата публикации.');}
}

/** Archive import uses the same byte-pinned startup gate as queued builds before creating a card. */
export async function withVerifiedToolImport<T>(prepared:IPreparedLocalAsset,blobs:Pick<AssetBlobStore,'checkedPath'>,publish:(report:BuildRuntimeReport)=>Promise<T>,signal:AbortSignal=AbortSignal.timeout(TOOL_IMPORT_TIMEOUT_MS)):Promise<T>{
    signal.throwIfAborted();
    const asset=prepared.asset;assertToolSupplyLayout(asset);
    const files=asset.delivery.artifacts.map(({descriptor})=>({sha256:descriptor.sha256,bytes:descriptor.compressedBytes,path:toolRuntimePath(descriptor.sha256)}));
    if(asset.source.type==='archive')files.push({sha256:asset.source.sha256,bytes:asset.source.bytes,path:toolSourcePath(asset.source.sha256)});
    if(asset.recipe){const recipe=prepared.blobs.find(item=>item.sha256===asset.recipe!.sha256);if(!recipe)throw new ConflictException('Нет проверенного рецепта импортируемой поставки.');files.push({sha256:recipe.sha256,bytes:recipe.bytes,path:asset.recipe.path});}
    const total=files.reduce((sum,file)=>sum+file.bytes,0);
    if(!Number.isSafeInteger(total)||total>4*1024**3)throw new ConflictException('Поставка для проверки превышает 4 ГиБ.');
    const temporary=await fs.realpath(os.tmpdir()),release=await reserveCapacity({resource:'runtime-artifacts',bytes:total+64*1024**2,path:temporary});
    let stage:string|undefined,cleanupConfirmed=true;
    try {
        signal.throwIfAborted();
        stage=await fs.mkdtemp(path.join(temporary,'neurocenter-import-runtime-'));await fs.chmod(stage,0o700);
        for(const file of files){
            signal.throwIfAborted();
            const source=await blobs.checkedPath(file.sha256,file.bytes,signal),destination=path.join(stage,file.path);
            signal.throwIfAborted();
            await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
            await pipeline(createReadStream(source),createWriteStream(destination,{flags:'wx',mode:0o600}),{signal});
        }
        signal.throwIfAborted();
        const manifest=path.join(stage,'asset.json');await fs.writeFile(manifest,serializeAsset(asset),{flag:'wx',mode:0o600,signal});
        const identity=`import:${prepared.requestKey}`,report=await verifyBuildRuntime(manifest,identity,signal);
        if(report.diagnostics.some(item=>item.code==='cleanup-failed')){cleanupConfirmed=false;throw new ToolImportCleanupPendingError(stage);}
        signal.throwIfAborted();
        if(!report.ok)throw new ConflictException(report.diagnostics[0]?.message??'Импортируемый пакет не прошёл проверку запуска.');
        await assertRuntimeCandidate(manifest,report,identity);
        signal.throwIfAborted();
        return await publish(report);
    }finally{if(cleanupConfirmed){
        if(stage)try{await fs.rm(stage,{recursive:true,force:true});}catch{throw new ToolImportCleanupPendingError(stage);}
        release();
    }}
}
