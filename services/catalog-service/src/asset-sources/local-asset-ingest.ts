import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import { ConflictException } from '@nestjs/common';
import { assetDigest, downloadArtifacts, serializeAsset, toToolPublication, validateAsset, type DependencyContext, type ToolAsset } from '@neurocenter/asset-contract';
import type { Pool, PoolClient } from 'pg';
import type { IAiPlugin, IAiPluginCreate } from '../catalog/dto';
import { publicationHash, validatePublication } from '../publication/publication-validation';
import { nativeCardHash } from '../publication/native-hash';
import { toolNativePin, toolPublication } from './tool-adapter';
import { AssetBlobStore, type IAssetBlob } from './asset-blob-store';
import { AssetImportRepository } from './import-repository';
import {assertToolSupplyLayout,TOOL_SOURCE_MAX_BYTES} from '../../../shared/tool-supply-paths.cjs';

export interface IPreparedLocalAsset {
    asset:ToolAsset;sha256:string;blobs:IAssetBlob[];requestKey:string;publication:IAiPluginCreate;
}
/** Producer-local и public repository используют одну envelope validation и один native versionmap. */
export class LocalAssetIngest {
    constructor(private readonly pool:Pool,private readonly blobs:AssetBlobStore){}
    async prepare(raw:ToolAsset,files:Array<IAssetBlob&{archivePath:string}>,requestKey:string,context?:DependencyContext,sourceFile?:{archivePath:string;stagingRoot:string},signal?:AbortSignal):Promise<IPreparedLocalAsset>{
        signal?.throwIfAborted();
        const checked=validateAsset(JSON.parse(JSON.stringify(raw)));
        if(checked.kind!=='mcp'&&checked.kind!=='plugin')throw new ConflictException('Local build supports a native tool envelope.');
        const asset=checked as ToolAsset,publication=validatePublication(toToolPublication(asset,context));
        try{assertToolSupplyLayout(asset);}catch{throw new ConflictException('Recipe path collides with another supply file.');}
        const expected=downloadArtifacts(asset).map(({sha256,bytes,filename,target})=>({sha256,bytes,filename,...(target?{target}:{})}));
        const supplied=files.map(({sha256,bytes,filename,target})=>({sha256,bytes,filename,...(target?{target}:{})}));
        if(publicationHash(expected)!==publicationHash(supplied))throw new ConflictException('Local archives do not match the immutable envelope inventory.');
        const recipe=await this.recipeFile(asset,signal);
        const retained=[...files];
        if(asset.source.type==='archive'){
            const source={sha256:asset.source.sha256,bytes:asset.source.bytes,filename:asset.source.sha256+'.source'};
            if(sourceFile){
                const root=await fs.realpath(sourceFile.stagingRoot),filename=path.resolve(sourceFile.archivePath),parent=await fs.realpath(path.dirname(filename));
                if(parent!==root||(await fs.lstat(sourceFile.stagingRoot)).isSymbolicLink())throw new ConflictException('Source snapshot must remain inside its owned staging directory.');
                const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
                try{const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.size!==source.bytes||before.size>TOOL_SOURCE_MAX_BYTES)throw new ConflictException('Source snapshot type or size changed.');
                    const hash=createHash('sha256');let bytes=0;
                    for await(const chunk of file.createReadStream({autoClose:false,signal})){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>source.bytes)throw new ConflictException('Source snapshot grew during verification.');hash.update(chunk);}
                    const after=await file.stat(),named=await fs.lstat(filename);
                    if(bytes!==source.bytes||hash.digest('hex')!==source.sha256||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==named.ino||before.dev!==named.dev||named.isSymbolicLink())throw new ConflictException('Source snapshot SHA-256 changed.');
                }finally{await file.close();}
                retained.push({...source,archivePath:filename});
            }else {
                let archivePath:string;try{archivePath=await this.blobs.checkedPath(source.sha256,source.bytes,signal);}catch{signal?.throwIfAborted();throw new ConflictException('Verified source snapshot bytes are required before local publication.');}
                retained.push({...source,archivePath});
            }
        }else if(sourceFile)throw new ConflictException('Only archive source can retain a local source snapshot.');
        if(recipe)retained.push(recipe);
        const blobs=await this.blobs.ingestLocal(retained,requestKey,signal);signal?.throwIfAborted();
        return {asset,publication,sha256:assetDigest(serializeAsset(asset)),blobs,requestKey};
    }
    /** Optional recipes are retained from registered SHA bytes before any local ingestion or publication. */
    private async recipeFile(asset:ToolAsset,signal?:AbortSignal):Promise<(IAssetBlob&{archivePath:string})|undefined>{
        signal?.throwIfAborted();
        if(!asset.recipe)return;
        const recipe=asset.recipe;
        const {rows}=await this.pool.query<{bytes:string}>('SELECT bytes FROM asset_source_blobs WHERE sha256=$1',[recipe.sha256]);
        const bytes=Number(rows[0]?.bytes);
        if(!Number.isSafeInteger(bytes)||bytes<1||bytes>1024*1024)throw new ConflictException('Verified recipe bytes up to1MiB are required before local publication.');
        let archivePath:string;
        try{archivePath=await this.blobs.checkedPath(recipe.sha256,bytes,signal);}
        catch{signal?.throwIfAborted();throw new ConflictException('Verified recipe SHA-256 bytes are required before local publication.');}
        return {archivePath,sha256:recipe.sha256,bytes,filename:recipe.path};
    }
    /** Caller owns the publication transaction and its durable build receipt. */
    async record(client:PoolClient,prepared:IPreparedLocalAsset,card:IAiPlugin,actor:string,replacement?:{replaceOrigins:Array<{repository:string;externalId:string;revision:number}>},signal?:AbortSignal){
        signal?.throwIfAborted();
        if(assetDigest(serializeAsset(validateAsset(prepared.asset)))!==prepared.sha256)throw new ConflictException('Prepared local envelope changed.');
        const actual=toolPublication(card),expected={...prepared.publication};delete actual.publicationKey;delete expected.publicationKey;
        if(publicationHash(actual)!==publicationHash(expected))throw new ConflictException('Native publication differs from its checked envelope.');
        for(const blob of prepared.blobs)await this.blobs.checkedPath(blob.sha256,blob.bytes,signal);
        signal?.throwIfAborted();
        const native=toolNativePin(card.id,card.version,actual,nativeCardHash(card));
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:'+card.kind+':'+card.id]);
        signal?.throwIfAborted();
        await new AssetImportRepository(this.pool).recordLocal(client,actor,{resolved:{asset:prepared.asset,sha256:prepared.sha256,path:'assets/'+prepared.asset.id+'/'+prepared.asset.version+'/asset.json',current:true},requestKey:prepared.requestKey,name:card.name,action:replacement?'update':'create',state:'SUCCEEDED',native,...(replacement?{replacesLocal:true,originReceipts:replacement.replaceOrigins}:{})},prepared.blobs);
        signal?.throwIfAborted();
        return {assetId:prepared.asset.id,sourceVersion:prepared.asset.version,sourceSha256:prepared.sha256};
    }
}
