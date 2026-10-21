const SHA=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safePath=value=>typeof value==='string'&&Buffer.byteLength(value)<=240&&!/[\\\x00-\x1f\x7f]/.test(value)
    &&value.split('/').every(part=>part.length>0&&!['.','..'].includes(part));
const fail=(code,message)=>Object.assign(new Error(message),{code});

/** Оператор выбирает публичный GitHub repository; каждый импорт закрепляет commit и SHA описи. */
function validateSourcePin(pin){
    if(!pin||typeof pin!=='object'||Array.isArray(pin)||Object.keys(pin).some(key=>!['schemaVersion','repository','commit','index'].includes(key))
        ||pin.schemaVersion!==1||typeof pin.repository!=='string'||! /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i.test(pin.repository)||['.','..'].includes(pin.repository.split('/')[1])||pin.repository.endsWith('.git')||typeof pin.commit!=='string'||!/^[a-f0-9]{40}$/.test(pin.commit)
        ||!pin.index||typeof pin.index!=='object'||Array.isArray(pin.index)||Object.keys(pin.index).some(key=>!['path','sha256'].includes(key))
        ||!safePath(pin.index.path)||!SHA(pin.index.sha256))throw fail('INVALID_PIN','Источник ассетов не закреплён корректным commit и SHA-256 описи.');
    return structuredClone(pin);
}

/** Один bounded reader используется сервером импорта и CLI предзагрузки. */
class AssetSourceClient {
    constructor(pin,{contract,fetch:request=globalThis.fetch,signal,cache,offline=false}={}){
        this.pin=validateSourcePin(pin);this.contract=contract;this.request=request;this.signal=signal;this.cache=cache;this.offline=offline;
    }
    async bytes(relative,expected,maximum){
        if(!safePath(relative)||!SHA(expected))throw fail('INVALID_SOURCE','В описи указан небезопасный путь или SHA-256.');
        this.signal?.throwIfAborted();
        const cached=await this.cache?.read(expected,maximum);
        if(cached&&cached.length<=maximum&&this.contract.assetDigest(cached)===expected)return cached;
        if(this.offline)throw fail('METADATA_MISSING','Закреплённая опись отсутствует или повреждена в кэше. Выполните npm run assets:sync.');
        const url=`https://raw.githubusercontent.com/${this.pin.repository}/${this.pin.commit}/${relative.split('/').map(encodeURIComponent).join('/')}`;
        const signal=AbortSignal.any([AbortSignal.timeout(15000),...(this.signal?[this.signal]:[])]);let response;
        try{signal.throwIfAborted();response=await this.request(url,{redirect:'error',signal});}
        catch{this.signal?.throwIfAborted();throw fail('UNAVAILABLE','Не удалось прочитать источник ассетов. Повторите после восстановления соединения.');}
        if(!response.ok||!response.body){await response.body?.cancel();throw fail('UNAVAILABLE','Источник ассетов не вернул закреплённый файл. Повторите позже.');}
        const size=response.headers.get('content-length');
        if(size!==null&&(!/^\d+$/.test(size)||Number(size)>maximum)){await response.body.cancel();throw fail('INVALID_SOURCE','Файл описи превышает допустимый размер.');}
        const reader=response.body.getReader(),chunks=[];let count=0;
        try{
            for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;count+=value.byteLength;
                if(count>maximum)throw fail('INVALID_SOURCE','Файл описи превышает допустимый размер.');chunks.push(value);}
            // Fetch распаковывает HTTP gzip/br; Content-Length в таком ответе описывает сжатые байты.
            if(size!==null&&(!response.headers.get('content-encoding')||response.headers.get('content-encoding')==='identity')&&count!==Number(size)){
                throw fail('INVALID_SOURCE','Размер описи отличается от объявленного источником.');
            }
        }catch(error){
            await reader.cancel().catch(()=>undefined);this.signal?.throwIfAborted();if(error.code==='INVALID_SOURCE')throw error;
            throw fail('UNAVAILABLE','Передача описи прервалась. Повторите чтение источника.');
        }finally{reader.releaseLock();}
        const bytes=Buffer.concat(chunks);
        if(this.contract.assetDigest(bytes)!==expected)throw fail('INVALID_SOURCE','SHA-256 описи отличается от закреплённого источника. Импорт остановлен.');
        await this.cache?.write?.(expected,bytes);return bytes;
    }
    json(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('INVALID_SOURCE','Закреплённая опись содержит некорректный JSON или UTF-8.');}}
    async index(){
        const bytes=await this.bytes(this.pin.index.path,this.pin.index.sha256,512*1024);
        try{return this.contract.validateIndex(this.json(bytes));}
        catch(error){if(error.code==='INVALID_SOURCE')throw error;throw fail('INVALID_SOURCE','Формат закреплённой описи ассетов не поддерживается.');}
    }
    async descriptor(entry){
        const bytes=await this.bytes(entry.path,entry.sha256,16*1024*1024);
        let asset;
        try{asset=this.contract.validateAsset(this.json(bytes));
            if(asset.id!==entry.id||asset.kind!==entry.kind||asset.version!==entry.version)throw new Error('Header mismatch');
        }catch{throw fail('INVALID_SOURCE','Ассет не соответствует закреплённой записи описи.');}
        if(asset.recipe)await this.bytes(asset.recipe.path,asset.recipe.sha256,1024*1024);
        return {asset,sha256:entry.sha256,path:entry.path,current:entry.current};
    }
    /** Весь граф разрешается до скачивания бинарников и записи карточек. */
    async select(ids){
        if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw fail('BAD_SELECTION','Выберите от 1 до 50 разных ассетов.');
        const index=await this.index(),tuple=(id,version)=>id+'@'+version,entries=new Map(index.assets.map(entry=>[tuple(entry.id,entry.version),entry]));
        const heads=new Map(index.assets.filter(entry=>entry.current).map(entry=>[entry.id,tuple(entry.id,entry.version)]));
        if(ids.some(id=>!heads.has(id)))throw fail('BAD_SELECTION','Выбранный ассет отсутствует в закреплённой описи.');
        const loaded=new Map(),queue=ids.map(id=>heads.get(id));let descriptorBytes=0;
        while(queue.length){
            this.signal?.throwIfAborted();const id=queue.shift();if(loaded.has(id))continue;const entry=entries.get(id);
            if(!entry)throw fail('INVALID_SOURCE','В описи отсутствует точная зависимость выбранного ассета.');
            if(loaded.size>=100)throw fail('BAD_SELECTION','Граф ассетов превышает 100 записей. Разделите импорт.');
            const resolved=await this.descriptor(entry);descriptorBytes+=Buffer.byteLength(JSON.stringify(resolved.asset));
            if(descriptorBytes>32*1024*1024)throw fail('BAD_SELECTION','Описи выбранного импорта превышают 32 МиБ. Разделите выбор.');loaded.set(id,resolved);
            for(const dependency of resolved.asset.dependencies||[]){const key=tuple(dependency.id,dependency.version),target=entries.get(key);
                if(!target||target.sha256!==dependency.sha256)throw fail('INVALID_SOURCE','В описи отсутствует точная зависимость выбранного ассета.');queue.push(key);}
        }
        try{return {index,assets:this.contract.selectAssets([...loaded.values()],ids)};}
        catch{throw fail('INVALID_SOURCE','Зависимости ассетов не образуют согласованный граф точных версий и SHA-256.');}
    }
}
module.exports={AssetSourceClient,validateSourcePin};
