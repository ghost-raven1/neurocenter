import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { assetDigest, assertIndexEvolution, validateIndex, selectAssets, type AssetIndex, type ResolvedAsset } from '@neurocenter/asset-contract';
import type { Pool } from 'pg';
import { AssetSourceClient, validateSourcePin, type IAssetSourcePin } from './source-client';

export interface ISourceSnapshot {pin:IAssetSourcePin;index:AssetIndex;assets:ResolvedAsset[];checked_at:string|Date}
/** Metadata refresh не скачивает binaries и не меняет каталог; каждый intent сохраняет выбранный commit. */
export class AssetSourceSnapshots {
    constructor(private readonly pool:Pool,private readonly initialPin:unknown,private readonly request:typeof fetch=fetch) {}
    async setup():Promise<void> {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS asset_source_snapshots (
            commit text PRIMARY KEY,pin jsonb NOT NULL,index jsonb NOT NULL,assets jsonb NOT NULL,checked_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS asset_source_refresh (id boolean PRIMARY KEY DEFAULT true CHECK(id),attempted_at timestamptz,message text)`);

    }
    async latest():Promise<ISourceSnapshot|undefined> {
        return (await this.pool.query<ISourceSnapshot>('SELECT * FROM asset_source_snapshots ORDER BY checked_at DESC,commit LIMIT 1')).rows[0];
    }
    async status() {
        const snapshot=await this.latest(),last=(await this.pool.query<{attempted_at:Date;message:string}>('SELECT attempted_at,message FROM asset_source_refresh WHERE id=true')).rows[0];
        return {snapshot,last};
    }
    async get(commit:string):Promise<ISourceSnapshot> {
        const saved=(await this.pool.query<ISourceSnapshot>('SELECT * FROM asset_source_snapshots WHERE commit=$1',[commit])).rows[0];
        if(!saved){throw new ConflictException('Выбранная проверенная версия источника уже недоступна. Обновите список.');}return saved;
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
        }catch(error){await this.pool.query('INSERT INTO asset_source_refresh(id,attempted_at,message) VALUES(true,now(),$1) ON CONFLICT(id) DO UPDATE SET attempted_at=now(),message=EXCLUDED.message',[error instanceof Error?error.message:'Не удалось проверить источник.']);throw error;}
    }
    private async load(pin:IAssetSourcePin,index?:AssetIndex):Promise<ISourceSnapshot> {
        const source=new AssetSourceClient(pin,this.request),checked=index??await source.index();
        if(checked.assets.length>300){throw new ConflictException('Источник содержит более 300 описей; импорт этой версии не поддерживается.');}
        const records:ResolvedAsset[]=[];let bytes=0;
        for(const entry of checked.assets){const record=await source.descriptor(entry);bytes+=Buffer.byteLength(JSON.stringify(record.asset));if(bytes>32*1024*1024){throw new ConflictException('Metadata источника превышает 32 МиБ.');}records.push(record);}
        selectAssets(records,checked.assets.filter(item=>item.current).map(item=>item.id));
        if(new Set(checked.assets.filter(item=>item.kind==='bridge').map(item=>item.id)).size>1){throw new ConflictException('Источник содержит несколько несовместимых bridge identities.');}
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:asset-source-refresh',0))");
            // Проверяются все известные snapshots, поэтому rollback ref не может забыть ранее опубликованную историю.
            const previous=await client.query<{index:AssetIndex;pin:IAssetSourcePin}>('SELECT index,pin FROM asset_source_snapshots');
            if(previous.rows.some(row=>row.pin.commit===pin.commit&&row.pin.index.sha256!==pin.index.sha256)){throw new ConflictException('Байты описи ранее проверенного commit изменились.');}
            try{for(const row of previous.rows){assertIndexEvolution(row.index,checked);}}catch{throw new ConflictException('Источник переписал или удалил уже опубликованную версию ассета. Обновление отклонено.');}
            const {rows}=await client.query<ISourceSnapshot>(`INSERT INTO asset_source_snapshots(commit,pin,index,assets) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb)
                ON CONFLICT(commit) DO UPDATE SET checked_at=now() RETURNING *`,[pin.commit,JSON.stringify(pin),JSON.stringify(checked),JSON.stringify(records)]);
            await client.query('COMMIT');return rows[0];
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
}
