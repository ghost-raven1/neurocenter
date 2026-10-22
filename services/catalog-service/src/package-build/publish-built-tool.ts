import type {Pool,PoolClient} from 'pg';
import {ConflictException} from '@nestjs/common';
import {PluginRepository} from '../publication/plugin-repository';
import type {IAiPluginCreate} from '../catalog/dto';
import type {AssetSourcesService} from '../asset-sources/asset-sources.service';
import type {IPreparedLocalAsset} from '../asset-sources/local-asset-ingest';
import {authorizeImportActor} from '../asset-sources/import-worker';
import type {BuildRow} from './package-build.model';
import type {PackageBuildRepository} from './package-build.repository';
import {lockBuildPublication} from './publication-target';

interface PublicationOptions {pool:Pool;lease:PoolClient;sources:AssetSourcesService;repository:PackageBuildRepository;row:BuildRow;publication:IAiPluginCreate;prepared:IPreparedLocalAsset;guard:()=>Promise<void>;discard:(client:PoolClient)=>void}

/** Native version, immutable source receipt and build success share the worker lease COMMIT. */
export async function publishBuiltTool({pool,lease,sources,repository,row,publication,prepared,guard,discard}:PublicationOptions):Promise<void>{
    const plugins=new PluginRepository(pool,discard),target=row.config.publication;
    const finish=async(client:PoolClient,published:Parameters<AssetSourcesService['recordLocal']>[2])=>{
        await authorizeImportActor(client,row.actor,true);await guard();
        const foreign=target?.origins.filter(owner=>owner.repository!=='local-archive'||owner.externalId!==prepared.asset.id).map(({repository,externalId,revision})=>({repository,externalId,revision}));
        const source=await sources.recordLocal(client,prepared,published,row.actor,target?{replaceOrigins:foreign??[]}:undefined);
        await repository.completeWithPublication(client,row.id,{catalogId:published.id,name:published.name,version:published.version,...source});
        await guard();
    };
    if(!target){await plugins.create(publication,row.actor,finish,lease);return;}
    await lease.query('BEGIN');
    try{
        await lockBuildPublication(lease,target);await authorizeImportActor(lease,row.actor,true);await guard();
        if(publication.name!==target.name||publication.kind!==target.kind)throw new ConflictException('Сборщик вернул другой инструмент для обновления.');
        const {name:_name,version:_version,publicationKey:_key,...changes}=publication;
        const saved=await plugins.update(target.catalogId,{...changes,expectedVersion:target.expectedVersion},row.actor,finish,lease,true);
        if(!saved)throw new ConflictException('Карточка отсутствует перед публикацией новой версии.');
        await guard();await lease.query('COMMIT');
    }catch(error){try{await lease.query('ROLLBACK');}catch{discard(lease);}throw error;}
}
