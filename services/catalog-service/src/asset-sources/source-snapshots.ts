import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { assetDigest, assertIndexEvolution, validateIndex, selectAssets, type AssetIndex, type ResolvedAsset } from '@neurocenter/asset-contract';
import type { Pool,PoolClient } from 'pg';
import { AssetSourceClient, validateSourcePin, type IAssetSourcePin, type AssetSourceTransport } from './source-client';
import {assetSourceTransport} from './source-cache';

export interface ISourceSnapshot {pin:IAssetSourcePin;index:AssetIndex;assets:ResolvedAsset[];checked_at:string|Date;archive_sha256?:string|null}
interface IBootstrapAdmission {admit:()=>Promise<void>;signal?:AbortSignal;published?:true}
/** Metadata refresh не скачивает binaries и не меняет каталог; каждый intent сохраняет выбранный commit. */
export class AssetSourceSnapshots {
    constructor(private readonly pool:Pool,private readonly initialPin:unknown,private readonly request:typeof fetch=fetch,private readonly transport:AssetSourceTransport=assetSourceTransport()) {}
    async latest():Promise<ISourceSnapshot|undefined> {
        return (await this.pool.query<ISourceSnapshot>('SELECT * FROM asset_source_snapshots ORDER BY checked_at DESC,commit LIMIT 1')).rows[0];
    }
    async status() {
        const snapshot=await this.latest(),last=(await this.pool.query<{attempted_at:Date;message:string}>('SELECT attempted_at,message FROM asset_source_refresh WHERE id=true')).rows[0];
        return {snapshot,last};
    }
    /** Only unavailable admission retries; absent or invalid local bytes settle without any source network fallback. */
    async bootstrap(admit:()=>Promise<void>,signal?:AbortSignal):Promise<{retry:boolean;published?:true}>{
        let retry=false;
        const admission:IBootstrapAdmission={signal,admit:async()=>{
            signal?.throwIfAborted();
            try{await admit();}catch(error){retry=!signal?.aborted;throw error;}
            signal?.throwIfAborted();
        }};
        try{
            signal?.throwIfAborted();
            if(await this.latest()||!this.initialPin||!this.transport.cache)return{retry:false};
            const pin=validateSourcePin(this.initialPin);
            if(await this.transport.cache.read(pin.index.sha256,512*1024)===undefined)return{retry:false};
            await admission.admit();await this.load(pin,undefined,admission);return admission.published?{retry:false,published:true}:{retry:false};
        }catch(error){
            if(signal?.aborted)return{retry:false};
            await this.pool.query('INSERT INTO asset_source_refresh(id,attempted_at,message) VALUES(true,now(),$1) ON CONFLICT(id) DO UPDATE SET attempted_at=now(),message=EXCLUDED.message',[error instanceof Error?error.message:'Не удалось проверить локальную поставку.']).catch(()=>undefined);
            return{retry};
        }
    }
    async get(commit:string,repository='ghost-raven1/neurocenter-assets'):Promise<ISourceSnapshot> {
        const saved=(await this.pool.query<ISourceSnapshot>(`SELECT pin,index,assets,checked_at,archive_sha256 FROM asset_source_snapshots WHERE commit=$1 AND pin->>'repository'=$2
            UNION ALL SELECT pin,index,assets,checked_at,NULL::text AS archive_sha256 FROM bridge_source_checks WHERE commit=$1 AND repository=$2 LIMIT 1`,[commit,repository])).rows[0];
        if(!saved){throw new ConflictException('Выбранная проверенная версия источника уже недоступна. Обновите список.');}return saved;
    }
    /** Archive bytes may reuse only an application pin or a previously verified snapshot. */
    async trustedPins():Promise<IAssetSourcePin[]>{
        const saved=(await this.pool.query<{pin:IAssetSourcePin}>('SELECT pin FROM asset_source_snapshots ORDER BY checked_at DESC,commit')).rows.map(row=>validateSourcePin(row.pin));
        return [...saved,...(this.initialPin?[validateSourcePin(this.initialPin)]:[])];
    }
    private async remote(url:string,maximum:number):Promise<Uint8Array> {
        let response:Response;
        try{response=await this.request(url,{redirect:'error',signal:AbortSignal.timeout(15_000),headers:{accept:'application/vnd.github+json'}});}
        catch{throw new ServiceUnavailableException('Источник недоступен. Сохранён последний проверенный список.');}
        if(!response.ok||!response.body){throw new ServiceUnavailableException(response.status===403||response.status===429?'GitHub ограничил запросы. Повторите обновление позже.':'Не удалось прочитать источник. Сохранён последний проверенный список.');}
        const declared=response.headers.get('content-length');
        if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum)){await response.body.cancel();throw new ConflictException('Metadata источника превышает допустимый размер.');}
        const chunks:Uint8Array[]=[];let count=0;const reader=response.body.getReader();
        try{for(;;){const {value,done}=await reader.read();if(done){break;}count+=value.byteLength;if(count>maximum){throw new ConflictException('Metadata источника превышает допустимый размер.');}chunks.push(value);}}
        catch(error){await reader.cancel().catch(()=>undefined);throw error;}finally{reader.releaseLock();}
        // Fetch декодирует gzip/br, а Content-Length описывает байты HTTP до декодирования.
        const encoding=response.headers.get('content-encoding');
        if(declared!==null&&(!encoding||encoding==='identity')&&count!==Number(declared)){throw new ConflictException('Metadata источника передана не полностью.');}
        return Buffer.concat(chunks);
    }
    async refresh():Promise<ISourceSnapshot> {
        try{
            if(this.transport.offline){
                const latest=await this.latest(),pin=latest?.archive_sha256?latest.pin:this.initialPin;
                if(!pin)throw new ConflictException('Локальная поставка не закреплена в конфигурации приложения.');
                const saved=await this.load(validateSourcePin(pin));
                await this.pool.query("INSERT INTO asset_source_refresh(id,attempted_at,message) VALUES(true,now(),'') ON CONFLICT(id) DO UPDATE SET attempted_at=now(),message=''");return saved;
            }
            if(!await this.latest()&&this.initialPin){return await this.load(validateSourcePin(this.initialPin));}
            // Репозиторий доверенный и фиксированный. Mutable ref разрешается ровно один раз на явное действие администратора.
            // Ref API не включает diff: размер очередного commit не меняет возможность обновить список.
            const bytes=await this.remote('https://api.github.com/repos/ghost-raven1/neurocenter-assets/git/ref/heads/main',64*1024);
            let commit:string;try{
                const reference=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
                if(reference.ref!=='refs/heads/main'||reference.object?.type!=='commit'){throw new Error('Invalid branch reference');}
                commit=reference.object.sha;
            }catch{throw new ConflictException('GitHub вернул неподдерживаемый ответ commit.');}
            if(typeof commit!=='string'||!/^[a-f0-9]{40}$/.test(commit)){throw new ConflictException('GitHub не подтвердил полный commit источника.');}
            const indexBytes=await this.remote('https://raw.githubusercontent.com/ghost-raven1/neurocenter-assets/'+commit+'/index.json',512*1024);
            let index:AssetIndex;try{index=validateIndex(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(indexBytes)));}catch{throw new ConflictException('Формат описи источника не поддерживается.');}
            const saved=await this.load({schemaVersion:1,repository:'ghost-raven1/neurocenter-assets',commit,index:{path:'index.json',sha256:assetDigest(indexBytes)}},index);
            await this.pool.query("INSERT INTO asset_source_refresh(id,attempted_at,message) VALUES(true,now(),'') ON CONFLICT(id) DO UPDATE SET attempted_at=now(),message=''");return saved;
        }catch(error){await this.pool.query('INSERT INTO asset_source_refresh(id,attempted_at,message) VALUES(true,now(),$1) ON CONFLICT(id) DO UPDATE SET attempted_at=now(),message=EXCLUDED.message',[error instanceof Error?error.message:'Не удалось проверить источник.']).catch(()=>undefined);throw error;}
    }
    private async load(pin:IAssetSourcePin,index?:AssetIndex,bootstrap?:IBootstrapAdmission):Promise<ISourceSnapshot> {
        const transport=bootstrap?{cache:this.transport.cache,offline:true}:this.transport;
        const source=new AssetSourceClient(pin,this.request,bootstrap?.signal,transport),checked=index??await source.index();
        if(checked.assets.length>300){throw new ConflictException('Источник содержит более 300 описей; импорт этой версии не поддерживается.');}
        const records:ResolvedAsset[]=[];let bytes=0;
        for(const entry of checked.assets){const record=await source.descriptor(entry);bytes+=Buffer.byteLength(JSON.stringify(record.asset));if(bytes>32*1024*1024){throw new ConflictException('Metadata источника превышает 32 МиБ.');}records.push(record);}
        selectAssets(records,checked.assets.filter(item=>item.current).map(item=>item.id));
        if(new Set(checked.assets.filter(item=>item.kind==='bridge').map(item=>item.id)).size>1){throw new ConflictException('Источник содержит несколько несовместимых bridge identities.');}
        return this.save(pin,checked,records,transport.offline?undefined:null,undefined,bootstrap);
    }
    /** Publish metadata only after full archive validation; history and actor fences share the commit. */
    async acceptArchive(pin:IAssetSourcePin,index:AssetIndex,records:ResolvedAsset[],sha:string,publish:(client:PoolClient)=>Promise<void>):Promise<ISourceSnapshot>{
        if(!/^[a-f0-9]{64}$/.test(sha))throw new ConflictException('Некорректный SHA архива источника.');
        return this.save(pin,index,records,sha,publish);
    }
    private async save(pin:IAssetSourcePin,checked:AssetIndex,records:ResolvedAsset[],archiveSha?:string|null,publish?:(client:PoolClient)=>Promise<void>,bootstrap?:IBootstrapAdmission):Promise<ISourceSnapshot>{
        const client=await this.pool.connect();
        let discard=false;
        try{
            await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:asset-source-refresh',0))");
            if(bootstrap){
                const existing=(await client.query<ISourceSnapshot>('SELECT * FROM asset_source_snapshots ORDER BY checked_at DESC,commit LIMIT 1')).rows[0];
                if(existing){await client.query('COMMIT');return existing;}
            }
            // Проверяются все известные snapshots, поэтому rollback ref не может забыть ранее опубликованную историю.
            const previous=await client.query<{index:AssetIndex;pin:IAssetSourcePin}>('SELECT index,pin FROM asset_source_snapshots');
            if(previous.rows.some(row=>row.pin.commit===pin.commit&&row.pin.index.sha256!==pin.index.sha256)){throw new ConflictException('Байты описи ранее проверенного commit изменились.');}
            try{for(const row of previous.rows){assertIndexEvolution(row.index,checked);}}catch{throw new ConflictException('Источник переписал или удалил уже опубликованную версию ассета. Обновление отклонено.');}
            await bootstrap?.admit();bootstrap?.signal?.throwIfAborted();
            await publish?.(client);
            const {rows}=await client.query<ISourceSnapshot>(`INSERT INTO asset_source_snapshots(commit,pin,index,assets,archive_sha256) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5)
                ON CONFLICT(commit) DO UPDATE SET checked_at=now(),archive_sha256=CASE WHEN $6::boolean THEN EXCLUDED.archive_sha256 ELSE asset_source_snapshots.archive_sha256 END RETURNING *`,[pin.commit,JSON.stringify(pin),JSON.stringify(checked),JSON.stringify(records),archiveSha??null,archiveSha!==undefined]);
            await client.query("INSERT INTO asset_source_refresh(id,attempted_at,message) VALUES(true,now(),'') ON CONFLICT(id) DO UPDATE SET attempted_at=now(),message=''");
            await client.query('COMMIT');if(bootstrap)bootstrap.published=true;return rows[0];
        }catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}finally{client.release(discard);}
    }
}
