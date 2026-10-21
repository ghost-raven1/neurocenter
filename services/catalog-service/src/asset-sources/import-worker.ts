import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import {requiredAssetFeatures} from '../../../shared/feature-policy.cjs';
import {AgentAssetAdapter} from './asset-agent-adapter';
import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { selectAssets, toBridgeRelease, type BridgeAsset } from '@neurocenter/asset-contract';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { validateImportPlan } from './import-planning';
import { AssetImportRepository } from './import-repository';
import { AssetSourceSnapshots } from './source-snapshots';
import { AssetBlobStore } from './asset-blob-store';
import { ToolAssetAdapter } from './tool-adapter';
import { SkillAssetAdapter } from './skill-adapter';
import { ModelAssetAdapter } from './asset-model-adapter';
import { RuntimeArtifacts } from '../runtime-artifacts/runtime-artifacts';
import type { IImportItem, IImportJob, ISourceReceipt } from './import-types';
import { publicationHash } from '../publication/publication-validation';
import {assertBridgeHead} from './bridge-source-head';

/** Проверяется и перед supply, и под SQL row lock перед публикацией. Отзыв прав не обходится фоновой задачей. */
export async function authorizeImportActor(client:Pick<PoolClient,'query'>,actor:string,lock=false):Promise<void> {
    const {rows}=await client.query<{is_main_admin:boolean;enabled:boolean}>('SELECT is_main_admin,enabled FROM platform_users WHERE email=$1'+(lock?' FOR SHARE':''),[actor]);
    if(!rows[0]?.enabled||!rows[0].is_main_admin){throw new ForbiddenException('Права главного администратора отозваны. Импорт остановлен.');}
}
const failureMessage=(error:unknown):string=>error instanceof HttpException?String(error.message).slice(0,1000):'Сервер не подтвердил этап импорта. Проверенные файлы сохранены; повтор продолжит эту операцию.';
/** Один session lease сериализует jobs; SQL publication, receipt и SUCCEEDED item объединены в COMMIT. */
export class AssetImportWorker {
    private active?:Promise<void>;private stopped=false;private abort?:AbortController;
    constructor(private readonly pool:Pool,private readonly jobs:AssetImportRepository,private readonly sources:AssetSourceSnapshots,
        private readonly blobs:AssetBlobStore,private readonly runtime:RuntimeArtifacts,
        private readonly tools=new ToolAssetAdapter(pool),private readonly skills=new SkillAssetAdapter(),private readonly models=new ModelAssetAdapter(pool),private readonly agents=new AgentAssetAdapter(pool)) {}
    kick():void {if(this.stopped||this.active){return;}this.active=this.drain().finally(()=>{this.active=undefined;});void this.active.catch(()=>undefined);}
    async flush():Promise<void>{this.kick();await this.active;}
    async stop():Promise<void>{this.stopped=true;this.abort?.abort(new Error('Сервер завершает работу'));await this.active?.catch(()=>undefined);}
    private async drain():Promise<void>{
        const client=await this.pool.connect(),abort=new AbortController();this.abort=abort;
        const failed=()=>abort.abort(new Error('Соединение владельца импорта потеряно'));client.on('error',failed);
        let locked=false;
        try{
            locked=!!(await client.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtextextended('neurocenter:asset-import-worker:'||current_schema(),0)) AS locked")).rows[0]?.locked;
            if(!locked){return;}
            while(!this.stopped&&!abort.signal.aborted){const job=await this.jobs.next(client);if(!job){break;}await this.process(job,client,abort.signal);}
        }finally{client.removeListener('error',failed);if(locked&&!abort.signal.aborted){await client.query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:asset-import-worker:'||current_schema(),0))").catch(()=>undefined);}client.release(abort.signal.aborted);this.abort=undefined;}
    }
    private async check(job:IImportJob,client:PoolClient,signal:AbortSignal):Promise<void>{
        signal.throwIfAborted();await authorizeImportActor(client,job.actor);
        const current=await this.jobs.get(job.id,undefined,client);if(current.cancel_requested){throw new ConflictException('Импорт остановлен пользователем. Уже опубликованные карточки сохранены.');}
    }
    private async prepare(job:IImportJob):Promise<IImportItem[]>{
        const source=await this.sources.get(job.source.commit,job.source.repository),records=selectAssets(source.assets,job.selected_ids);
        if(records.length>100){throw new ConflictException('Замыкание импорта превышает 100 ассетов. Разделите выбор.');}
        const [receipts,versions]=await Promise.all([this.jobs.receipts(job.source.repository),this.jobs.versions(job.source.repository)]),items:IImportItem[]=[];
        for(const resolved of records){
            const receipt=receipts.find(item=>item.external_id===resolved.asset.id),version=receipt?.active===false&&resolved.current?undefined:versions.find(item=>item.external_id===resolved.asset.id&&item.asset_version===resolved.asset.version);
            const key=randomUUID(),overrideHash=job.replacement_hashes?.[resolved.asset.id+'@'+resolved.asset.version];let item:IImportItem;
            switch(resolved.asset.kind){
                case 'mcp':case 'plugin':item=await this.tools.preview(resolved,key,items,receipt,version,overrideHash);break;
                case 'skill':item=await this.skills.preview(resolved,key,items,receipt,version,overrideHash);break;
                case 'agent':item=await this.agents.preview(resolved,key,items,receipt,version,overrideHash);break;
                case 'model':item=await this.models.preview(resolved,key,items,receipt,version,overrideHash);break;
                case 'bridge':{
                    if(!version)await assertBridgeHead(this.pool,resolved.asset);
                    const release=toBridgeRelease(resolved.asset as BridgeAsset);
                    item={resolved,requestKey:key,name:resolved.asset.card.name,state:'PENDING',action:version?'unchanged':receipt?'update':'create',
                        preserveHead:!!version||!!receipt&&!resolved.current,native:{kind:'bridge',id:resolved.asset.id,version:version?.native_version??Math.max(0,...versions.filter(value=>value.external_id===resolved.asset.id).map(value=>value.native_version),...items.filter(value=>value.native?.kind==='bridge'&&value.native.id===resolved.asset.id).map(value=>value.native!.version))+1,hash:resolved.sha256},
                        payload:{version:release.version,buildId:release.buildId}};
                    if(version&&version.descriptor_sha256!==resolved.sha256){item={...item,action:'conflict',reason:'Опись известной версии моста переписана.'};}break;
                }
            }
            const nativeId=item.native?.id??item.expected?.id;
            if(nativeId&&receipts.some(other=>other.native_id===nativeId&&other.asset_kind===resolved.asset.kind&&other.external_id!==resolved.asset.id)){item={...item,action:'conflict',replaceable:false,reason:'Эта native-карточка уже связана с другим ассетом источника. Нельзя присвоить ей вторую идентичность.'};}
            if(nativeId&&!item.preserveHead){
                const owners=(await this.pool.query<ISourceReceipt>('SELECT * FROM asset_source_receipts WHERE asset_kind=$1 AND native_id=$2 AND active ORDER BY repository,external_id',[resolved.asset.kind,nativeId])).rows;
                const foreign=owners.filter(owner=>owner.repository!==job.source.repository||owner.external_id!==resolved.asset.id);
                if(foreign.length||receipt?.active===false){
                    const expected=item.expected??item.native,originReceipts=foreign.map(owner=>({repository:owner.repository,externalId:owner.external_id,revision:Number(owner.revision)}));
                    const approved=!!expected&&overrideHash===expected.hash&&publicationHash(job.replacement_origins?.[resolved.asset.id+'@'+resolved.asset.version]??[])===publicationHash(originReceipts);
                    item={...item,originReceipts,
                        ...(approved?{replacesLocal:true}:{action:'conflict',expected,replaceable:!!expected&&resolved.current,reason:'Карточка управляется источником '+foreign.map(owner=>owner.repository+'/'+owner.external_id).join(', ')+'. Явное принятие нового источника сохраняет прежнее происхождение и версии.'})};
                }
            }
            items.push(item);
        }
        if(!items.some(item=>item.action==='conflict')){validateImportPlan(items);}
        return items;
    }
    private async process(initial:IImportJob,client:PoolClient,signal:AbortSignal):Promise<void>{
        let job=initial;
        try{
            await this.check(job,client,signal); await requireFeaturesEnabled(['asset_sources']);
            if(!job.items.length){
                const items=await this.prepare(job),conflict=items.some(item=>item.action==='conflict');
                job=await this.jobs.save(client,job,conflict?'NEEDS_INPUT':'RUNNING',conflict?'Импорт остановлен до скачивания: исправьте указанные конфликты.':'План проверен. Загружаем и проверяем выбранные файлы.',items);
                if(conflict){return;}
            }else{job=await this.jobs.save(client,job,'RUNNING','Продолжаем сохранённые этапы импорта.');}
            for(let index=0;index<job.items.length;index++){
                let item=job.items[index];if(item.state==='SUCCEEDED'){continue;}
                await this.check(job,client,signal); await requireFeaturesEnabled(['asset_sources',...requiredAssetFeatures(item.resolved.asset.kind)]);
                item={...item,state:'RUNNING',message:'Проверяем файлы поставки'};job.items[index]=item;
                job=await this.jobs.save(client,job,'RUNNING','Обрабатываем «'+item.name+'»');
                const blobs=await this.blobs.importAsset(item.resolved.asset,item.requestKey,signal,job.cache_only===true);
                if(item.resolved.asset.kind==='mcp'||item.resolved.asset.kind==='plugin'){
                    for(const entry of item.resolved.asset.delivery.artifacts){await this.check(job,client,signal);await this.runtime.importArchive(await this.blobs.checkedPath(entry.descriptor.sha256,entry.descriptor.compressedBytes),entry.descriptor);}
                }
                // Скилл сохраняется отдельным durable FS commit. Потеря ACK возобновляется по тому же requestKey.
                await client.query('BEGIN');
                try{
                    await authorizeImportActor(client,job.actor,true);await this.check(job,client,signal);
                    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:'+item.resolved.asset.kind+':'+(item.expected?.id??item.native!.id)]);
                    let skillPin;if(item.resolved.asset.kind==='skill'){skillPin=await this.skills.publish(item,job.actor);}
                    const finish=async(native:NonNullable<IImportItem['native']>)=>{
                        if(['mcp','plugin','model','agent'].includes(native.kind)&&item.native&&(native.id!==item.native.id||native.version!==item.native.version||native.manifest!==item.native.manifest||native.hash!==item.native.hash)){
                            throw new ConflictException('Native-публикация отличается от закреплённого плана. Зависимые карточки не опубликованы.');
                        }
                        item={...item,native,state:'SUCCEEDED',message:item.resolved.asset.kind==='model'&&item.resolved.asset.delivery.type==='remote-api'?'Карточка добавлена. Подключение API настраивается отдельно.':'Добавлено и проверено'};
                        job.items[index]=item;await this.jobs.receipt(client,job,item,blobs);
                        job=await this.jobs.save(client,job,'RUNNING','Сохранён этап «'+item.name+'»');
                    };
                    if(item.resolved.asset.kind==='mcp'||item.resolved.asset.kind==='plugin'){await this.tools.publish(item,job.actor,client,async card=>finish(this.tools.pin(card)));}
                    else if(item.resolved.asset.kind==='agent'){await finish(await this.agents.publish(item,job.actor,client));}
                    else if(item.resolved.asset.kind==='model'){await finish(await this.models.publish(item,job.actor,client));}
                    else{await finish(skillPin??item.native!);}
                    await client.query('COMMIT');
                }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
            }
            await this.jobs.save(client,job,'SUCCEEDED','Выбранные ассеты и точные зависимости добавлены.');
        }catch(error){
            if(signal.aborted){return;}
            // COMMIT с потерянным ACK может уже сохраниться: перечитываем durable state, прежде чем писать ошибку.
            const durable=await this.jobs.get(job.id,undefined,client),cancelled=durable.cancel_requested;
            if(durable.state==='SUCCEEDED'){return;}
            const partial=durable.items.some(item=>item.state==='SUCCEEDED');
            const items=durable.items.map(item=>item.state==='RUNNING'?{...item,state:'FAILED' as const,message:failureMessage(error)}:item);
            await this.jobs.save(client,durable,cancelled?'CANCELLED':partial?'PARTIAL':error instanceof ConflictException?'NEEDS_INPUT':'FAILED',failureMessage(error),items);
        }
    }
}
