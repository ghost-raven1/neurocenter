import {visionFixture} from '../../../shared/vision-fixture.cjs';
import {statfs} from 'node:fs/promises';
import path from 'node:path';
import type {IModel} from './model.types';

export interface IModelProgress {stage:string;message:string;progress:number|null;}
export interface IRuntimeModelStatus {
    state:'unavailable'|'missing'|'stopped'|'ready'|'error';message:string;checkedAt:string|null;
}
type JsonObject = Record<string,unknown>;
type Progress = (value:IModelProgress)=>void|Promise<void>;
const modelName = /^(?:[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;
const object = (value:unknown):value is JsonObject => !!value&&typeof value==='object'&&!Array.isArray(value);
const unavailable = () => new Error('Хостинг моделей недоступен. Проверьте запуск проектного runtime.');
type DiskReader = (directory:string,options:{bigint:true})=>Promise<{bavail:bigint;bsize:bigint}>;
const gibibyte=1024**3;

/** Адрес задаёт оператор; карточка модели не может перенаправить запрос на другой сервер. */
export function modelRuntimeUrl(env:NodeJS.ProcessEnv=process.env):string {
    const supplied = env.MODEL_RUNTIME_URL;
    if(env.NODE_ENV==='production'&&!supplied)throw new Error('В production требуется MODEL_RUNTIME_URL управляемого runtime.');
    let url:URL;
    try {url=new URL(supplied||'http://127.0.0.1:11435');} catch {throw new Error('Некорректный MODEL_RUNTIME_URL.');}
    if(url.protocol!=='http:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'
        ||!(env.NODE_ENV==='production'?url.hostname==='model-runtime'&&url.port==='11434'
            :['127.0.0.1','localhost','[::1]','model-runtime'].includes(url.hostname))) {
        throw new Error('MODEL_RUNTIME_URL должен указывать на локальный управляемый runtime без пароля и дополнительных путей.');
    }
    return url.origin;
}

/** Ограниченный клиент Ollama: только операции над зарегистрированной моделью, без shell и Docker. */
export class OllamaClient {
    private readonly fetch:typeof globalThis.fetch;
    private readonly environment:NodeJS.ProcessEnv;
    private readonly disk:DiskReader;
    constructor(options:{fetch?:typeof globalThis.fetch;env?:NodeJS.ProcessEnv;statfs?:DiskReader}={}) {
        this.fetch=options.fetch||globalThis.fetch;this.environment=options.env||process.env;this.disk=options.statfs||statfs;
    }

    async status(model:IModel):Promise<IRuntimeModelStatus> {
        this.assertModel(model);
        if(this.environment.MODEL_HOSTING_ENABLED==='false')return {state:'unavailable',message:'Хостинг моделей отключён администратором сервера.',checkedAt:null};
        try {
            const tags=await this.request('/api/tags');
            const installed=this.entry(tags,model);
            if(!installed)return {state:'missing',message:'Веса модели ещё не подготовлены.',checkedAt:null};
            if(!this.digestMatches(model,installed))return {state:'error',message:'SHA установленной модели отличается от закреплённой версии.',checkedAt:null};
            const running=this.entry(await this.request('/api/ps'),model);
            return running?{state:'ready',message:'Модель загружена в память.',checkedAt:null}
                :{state:'stopped',message:'Веса сохранены; модель выгружена из памяти.',checkedAt:null};
        } catch {return {state:'unavailable',message:'Хостинг моделей недоступен. Проверьте запуск проектного runtime.',checkedAt:null};}
    }

    async start(model:IModel,onProgress:Progress=()=>{},signal?:AbortSignal):Promise<void> {
        this.assertModel(model);
        await onProgress({stage:'preparing',message:'Проверяем сохранённую модель.',progress:0});
        const existing=this.entry(await this.request('/api/tags',undefined,signal),model);
        if(existing&&!this.digestMatches(model,existing))throw new Error('SHA установленной модели отличается от закреплённой версии. Существующие веса сохранены.');
        if(!existing) {
            const known=model.source==='builtin'?{'qwen3-embedding:4b':2496704041,'qwen3-vl:2b-instruct':1930568531}[model.model]:undefined;
            const required=known||this.downloadMaximum();
            if(required>this.downloadMaximum())throw new Error('Модель превышает установленный на сервере лимит загрузки.');
            await this.checkCapacity(required+64*1024**2);
            await this.pull(model,onProgress,signal);
        }
        await onProgress({stage:'checking',message:'Проверяем версию и содержательный ответ модели.',progress:90});
        await this.check(model,signal);
        await onProgress({stage:'ready',message:'Модель готова к работе.',progress:100});
    }

    /** Статус не подменяет проверку: здесь проверяются digest, возможности и настоящий ответ. */
    async check(model:IModel,signal?:AbortSignal):Promise<void> {
        this.assertModel(model);
        const installed=this.entry(await this.request('/api/tags',undefined,signal),model);
        if(!installed)throw new Error('Веса модели не подготовлены. Сначала запустите хостинг модели.');
        if(!this.digestMatches(model,installed))throw new Error('SHA установленной модели отличается от закреплённой версии.');
        const metadata=await this.request('/api/show',{model:model.model},signal,30000);
        const required=model.capability==='chat'?'completion':model.capability;
        if(!Array.isArray(metadata.capabilities)||!metadata.capabilities.includes(required))throw new Error('Возможности модели не соответствуют карточке каталога.');
        if(model.capability==='embedding')await this.probeEmbedding(model,signal);
        else await this.probeChat(model,signal);
    }

    /** Останавливается только выбранная модель; общие веса и соседние модели сохраняются. */
    async stop(model:IModel,signal?:AbortSignal):Promise<void> {
        this.assertModel(model);
        const installed=this.entry(await this.request('/api/tags',undefined,signal),model);
        if(!installed)return;
        if(!this.digestMatches(model,installed))throw new Error('SHA установленной модели отличается от закреплённой версии.');
        // Пустой chat поддерживает unload как для completion, так и для embedding-моделей.
        const value=await this.request('/api/chat',{model:model.model,messages:[],stream:false,keep_alive:0},signal,30000);
        if(value.model!==model.model||value.done!==true||value.done_reason!=='unload')throw new Error('Runtime не подтвердил выгрузку модели.');
        if(this.entry(await this.request('/api/ps',undefined,signal),model))throw new Error('Модель ещё находится в памяти. Повторите проверку состояния.');
    }

    /** Пользовательский прокси ограничен двумя протоколами; ID модели берётся из карточки. */
    async infer(model:IModel,endpoint:'embed'|'chat',body:JsonObject,signal?:AbortSignal):Promise<JsonObject> {
        this.assertModel(model);
        if(!['embed','chat'].includes(endpoint)||endpoint==='embed'&&model.capability!=='embedding'
            ||endpoint==='chat'&&model.capability==='embedding')throw new Error('Протокол запроса не соответствует модели.');
        const installed=this.entry(await this.request('/api/tags',undefined,signal),model);
        if(!installed||!this.digestMatches(model,installed))throw new Error('Подготовленная версия модели недоступна.');
        const value=await this.request('/api/'+endpoint,{...body,model:model.model,stream:false,keep_alive:'5m'},signal,600000,16*1024*1024);
        if(value.model!==model.model)throw new Error('Runtime вернул ответ другой модели.');
        if(endpoint==='embed') {
            const count=Array.isArray(body.input)?body.input.length:1;
            if(!this.validVectors(value.embeddings,count,model.dimension))throw new Error('Runtime вернул некорректные векторы.');
        } else if(value.done!==true||!['stop','length'].includes(String(value.done_reason))||!object(value.message)
            ||typeof value.message.content!=='string'||!value.message.content.trim())throw new Error('Runtime не завершил ответ модели.');
        return value;
    }

    private assertModel(model:IModel) {
        if(model.runtime!=='ollama'||!modelName.test(model.model)||/[\x00-\x20\x7f]/.test(model.model)||model.model.length>200
            ||model.source==='builtin'&&!/^[a-f0-9]{64}$/.test(model.manifestSha256||''))throw new Error('Некорректная модель управляемого хостинга.');
    }

    private entry(value:JsonObject,model:IModel):JsonObject|undefined {
        if(!Array.isArray(value.models)||value.models.length>5000||value.models.some(item=>!object(item)))throw new Error('Runtime вернул некорректный список моделей.');
        return (value.models as JsonObject[]).find(item=>item.name===model.model||item.model===model.model);
    }
    private digestMatches(model:IModel,entry:JsonObject):boolean {return !model.manifestSha256||entry.digest===model.manifestSha256;}

    private validVectors(vectors:unknown,count:number,dimension:number|null):boolean {
        return Array.isArray(vectors)&&vectors.length===count&&count>0&&vectors.every(vector=>
            Array.isArray(vector)&&vector.length>0&&vector.length<=16384&&(dimension===null||vector.length===dimension)
            &&vector.some(number=>Math.fround(number)!==0)&&vector.every(number=>typeof number==='number'&&Number.isFinite(Math.fround(number))))
            &&vectors.every(vector=>vector.length===vectors[0].length);
    }

    private downloadMaximum():number {
        const maximum=Number(this.environment.MODEL_DOWNLOAD_MAX_BYTES||16*gibibyte);
        if(!Number.isSafeInteger(maximum)||maximum<gibibyte||maximum>1024*gibibyte)throw new Error('Некорректный лимит загрузки моделей на сервере.');
        return maximum;
    }

    /** Весам нужен физический запас на их томе; cached start не требует места под повторную загрузку. */
    private async checkCapacity(bytes:number) {
        let available:bigint;
        try {
            const disk=await this.disk(this.environment.MODEL_STORAGE_PATH||path.resolve(__dirname,'../../../../data/embedding'),{bigint:true});
            available=disk.bavail*disk.bsize;
        } catch {throw new Error('Не удалось проверить свободное место в хранилище моделей. Загрузка не начата.');}
        if(available<BigInt(bytes+gibibyte))throw new Error('Недостаточно свободного места для модели с резервом 1 ГиБ. Загрузка остановлена; сохранённые данные не удалены.');
    }

    private async probeEmbedding(model:IModel,signal?:AbortSignal) {
        const value=await this.request('/api/embed',{model:model.model,input:['Локальная проверка базы знаний.','Local knowledge test.'],truncate:false,keep_alive:'5m'},signal,180000);
        if(value.model!==model.model||!this.validVectors(value.embeddings,2,model.dimension))throw new Error('Модель не вернула корректные ненулевые векторы ожидаемой размерности.');
    }

    private async probeChat(model:IModel,signal?:AbortSignal) {
        const vision=model.capability==='vision';
        const content=vision?'Read the digits at the top and the color of the square at the bottom. Return only JSON with string fields number and color. Use an English lowercase color name.':'Reply with the word OK.';
        const value=await this.request('/api/chat',{model:model.model,messages:[{role:'user',content,...(vision?{images:[visionFixture().toString('base64')]}:{})}],
            stream:false,think:false,keep_alive:'5m',options:{temperature:0,num_ctx:4096,num_predict:64},
            ...(vision?{format:{type:'object',properties:{number:{type:'string'},color:{type:'string'}},required:['number','color'],additionalProperties:false}}:{})},signal,600000);
        const message=value.message;
        if(value.model!==model.model||value.done!==true||value.done_reason!=='stop'||!object(message)||typeof message.content!=='string'
            ||!message.content.trim()||message.content.length>32768)throw new Error('Модель не вернула завершённый содержательный ответ.');
        if(vision) {
            let observation:unknown;
            try {observation=JSON.parse(message.content);} catch {throw new Error('Модель не распознала тестовое изображение.');}
            if(!object(observation)||Object.keys(observation).length!==2||observation.number!=='42'||observation.color!=='red')throw new Error('Модель неверно распознала число или цвет тестового изображения.');
        }
    }

    private async response(endpoint:string,body:JsonObject|undefined,signal:AbortSignal|undefined,timeout:number):Promise<Response> {
        if(this.environment.MODEL_HOSTING_ENABLED==='false')throw new Error('Хостинг моделей отключён администратором сервера.');
        try {
            return await this.fetch(modelRuntimeUrl(this.environment)+endpoint,{method:body===undefined?'GET':'POST',redirect:'error',
                signal:AbortSignal.any([AbortSignal.timeout(timeout),...(signal?[signal]:[])]),
                ...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
        } catch {throw unavailable();}
    }

    private async request(endpoint:string,body?:JsonObject,signal?:AbortSignal,timeout=5000,limit=1024*1024):Promise<JsonObject> {
        const response=await this.response(endpoint,body,signal,timeout);
        if(!response.ok||!response.body) {await response.body?.cancel();throw new Error(`Модельный runtime отклонил запрос (HTTP ${response.status}).`);}
        let size=0;const chunks:Uint8Array[]=[];
        for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            size+=chunk.length;if(size>limit)throw new Error('Ответ модельного runtime превышает допустимый размер.');chunks.push(chunk);
        }
        let value:unknown;
        try {value=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new Error('Runtime вернул некорректный JSON.');}
        if(!object(value)||value.error)throw new Error('Runtime не выполнил запрос.');
        return value;
    }

    private async pull(model:IModel,onProgress:Progress,signal?:AbortSignal) {
        const maximum=this.downloadMaximum();
        const response=await this.response('/api/pull',{model:model.model,stream:true},signal,30*60*1000);
        if(!response.ok||!response.body) {await response.body?.cancel();throw new Error(`Загрузка модели отклонена (HTTP ${response.status}).`);}
        let pending='',received=0,success=false;const decoder=new TextDecoder();
        const layers=new Map<string,{total:number;completed:number}>();
        const line=async(raw:string)=>{
            if(Buffer.byteLength(raw)>65536)throw new Error('Слишком длинная запись состояния загрузки модели.');
            if(!raw.trim())return;
            let value:unknown;
            try {value=JSON.parse(raw);} catch {throw new Error('Некорректный поток загрузки модели.');}
            if(!object(value)||value.error||typeof value.status!=='string')throw new Error('Загрузка модели прервана. Повторный запуск продолжит подготовку.');
            const total=value.total,completed=value.completed;
            if(total!==undefined) {
                if(!Number.isSafeInteger(total)||Number(total)<0||typeof value.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(value.digest)
                    ||completed!==undefined&&(!Number.isSafeInteger(completed)||Number(completed)<0||Number(completed)>Number(total)))throw new Error('Некорректный размер файлов модели в потоке загрузки.');
                layers.set(value.digest,{total:Number(total),completed:Number(completed||0)});
            }
            let expected=0,downloaded=0;
            for(const layer of layers.values()) {expected+=layer.total;downloaded+=layer.completed;}
            if(expected>maximum)throw new Error('Модель превышает установленный на сервере лимит загрузки. Выберите меньшую модель.');
            await this.checkCapacity(64*1024**2);
            success=value.status==='success';
            const percent=expected>0?Math.min(85,Math.floor(85*downloaded/expected)):null;
            await onProgress({stage:'downloading',message:success?'Веса загружены.':'Подготавливаем файлы модели.',progress:percent});
        };
        for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            received+=chunk.length;if(received>16*1024*1024)throw new Error('Поток состояния загрузки модели превышает лимит.');
            pending+=decoder.decode(chunk,{stream:true});
            let end:number;
            while((end=pending.indexOf('\n'))!==-1) {await line(pending.slice(0,end));pending=pending.slice(end+1);}
            if(Buffer.byteLength(pending)>65536)throw new Error('Слишком длинная запись состояния загрузки модели.');
        }
        pending+=decoder.decode();await line(pending);
        if(!success)throw new Error('Загрузка модели прервана. Повторный запуск продолжит подготовку.');
    }
}
