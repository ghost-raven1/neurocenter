import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import { captureProjectAsset, checkedProjectPackage, projectAssetColumns, projectAssetView, type IProjectPinRow } from './project-asset-pins';
import { publicationHash } from '../publication/publication-validation';

/** Назначение хранит exact native snapshot; повтор add сохраняет ранее выбранную версию. */
export class ProjectAssetRepository {
    constructor(private readonly pool:Pool) {}
    private async transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
        const client=await this.pool.connect();
        try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
        catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }
    private lock(client:PoolClient,id:string,kind:string){return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:'+kind+':'+id]);}
    private async audit(client:PoolClient,actor:string,action:'add'|'remove'|'pin',before:IProjectPinRow|null,after:IProjectPinRow|null){
        const row=after??before!;
        await securityEvent(client,{actor,action:'project.asset.'+action,resourceId:`${row.project_id} · ${row.asset_kind} · ${row.asset_id}`,
            before:before?{projectId:before.project_id,...projectAssetView(before)}:null,after:after?{projectId:after.project_id,...projectAssetView(after)}:null});
    }
    add(projectId:string,id:string,kind:string,actor:string):Promise<void>{
        return this.transaction(async client=>{
            await this.lock(client,id,kind);
            if((await client.query('SELECT 1 FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3',[projectId,id,kind])).rowCount)return;
            const snapshot=await captureProjectAsset(client,id,kind);
            const result=await client.query<IProjectPinRow>(`INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot)
                VALUES($1,$2,$3,$4,$5,$6,'assigned',$7) ON CONFLICT(project_id,asset_id,asset_kind) DO NOTHING RETURNING ${projectAssetColumns}`,
            [projectId,id,kind,actor,snapshot.package.plugin.version,snapshot.package.manifest.sha256,JSON.stringify(snapshot)]);
            if(result.rows[0])await this.audit(client,actor,'add',null,result.rows[0]);
        });
    }
    /** Смена закрепления требует просмотренного old pin; add не служит обходом CAS. */
    pin(projectId:string,id:string,kind:string,actor:string,raw:unknown):Promise<void>{
        const input=raw as {version?:unknown;expectedVersion?:unknown;expectedManifest?:unknown};
        if(!input||Object.keys(input).some(key=>!['version','expectedVersion','expectedManifest'].includes(key))||!Number.isSafeInteger(input.version)||Number(input.version)<1
            ||!(input.expectedVersion===null||Number.isSafeInteger(input.expectedVersion)&&Number(input.expectedVersion)>0)
            ||!(input.expectedManifest===null||typeof input.expectedManifest==='string'&&/^[a-f0-9]{64}$/.test(input.expectedManifest)))throw new BadRequestException('Нужны выбранная версия и прежний pin проекта.');
        return this.transaction(async client=>{
            await this.lock(client,id,kind);
            const before=(await client.query<IProjectPinRow>(`SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3 FOR UPDATE`,[projectId,id,kind])).rows[0];
            if(!before||before.asset_version!==input.expectedVersion||before.asset_manifest!==input.expectedManifest)throw new ConflictException('Назначение проекта изменилось. Обновите каталог перед выбором версии.');
            const snapshot=await captureProjectAsset(client,id,kind,Number(input.version));
            if(before.asset_version===input.version&&before.asset_manifest===snapshot.package.manifest.sha256)return;
            const after=(await client.query<IProjectPinRow>(`UPDATE project_assets SET asset_version=$4,asset_manifest=$5,pin_origin='manual',pin_snapshot=$6 WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3 RETURNING ${projectAssetColumns}`,
                [projectId,id,kind,snapshot.package.plugin.version,snapshot.package.manifest.sha256,JSON.stringify(snapshot)])).rows[0];
            await this.audit(client,actor,'pin',before,after);
        });
    }
    async catalog(projectId:string){
        const rows=(await this.pool.query<IProjectPinRow>(`SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 ORDER BY added_at DESC,asset_kind,asset_id`,[projectId])).rows;
        const assets: Array<ReturnType<typeof projectAssetView>&{card?:Record<string,unknown>}>=rows.map(projectAssetView);
        for(let i=0;i<rows.length;i++){
            const row=rows[i];
            try{
                const pkg=checkedProjectPackage(row),card=row.pin_snapshot!.card;
                // Display metadata is not allowed to claim a different version than the executable snapshot.
                if(!card||typeof card!=='object'||publicationHash(card)===publicationHash({}))throw new Error('Карточка отсутствует');
                if(row.asset_kind==='skill')assets[i].card={...card,path:row.asset_id,meta:{...(card.meta as object),version:pkg.plugin.version}};
                else assets[i].card={...card,id:row.asset_id,kind:row.asset_kind,version:pkg.plugin.version};
            }catch(error){assets[i].pinError=error instanceof Error?error.message:'Снимок назначения недоступен';}
        }
        return assets;
    }
    remove(projectId:string,id:string,kind:string,actor:string):Promise<boolean>{
        return this.transaction(async client=>{await this.lock(client,id,kind);
            const result=await client.query<IProjectPinRow>(`DELETE FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3 RETURNING ${projectAssetColumns}`,[projectId,id,kind]);
            if(!result.rows[0])return false;await this.audit(client,actor,'remove',result.rows[0],null);return true;});
    }
}
