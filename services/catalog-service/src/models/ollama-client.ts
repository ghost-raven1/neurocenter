import {visionFixture} from '../../../shared/vision-fixture.cjs';
import type {IModel,IModelVerification} from './model.types';
import {localModelAlias} from './local-model-alias';

export interface IModelProgress {stage:string;message:string;progress:number|null;}
export interface IRuntimeModelStatus {
    state:'unavailable'|'missing'|'stopped'|'ready'|'error';message:string;checkedAt:string|null;
}
type JsonObject = Record<string,unknown>;
type Progress = (value:IModelProgress)=>void|Promise<void>;
const modelName = /^(?:[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;
const object = (value:unknown):value is JsonObject => !!value&&typeof value==='object'&&!Array.isArray(value);
const unavailable = () => new Error('Хостинг моделей недоступен. Проверьте запуск проектного runtime.');

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
    constructor(options:{fetch?:typeof globalThis.fetch;env?:NodeJS.ProcessEnv}={}) {
        this.fetch=options.fetch||globalThis.fetch;this.environment=options.env||process.env;
    }

    async status(model:IModel):Promise<IRuntimeModelStatus> {
        this.assertModel(model);
        if(!model.manifestSha256)return {state:'missing',message:'Импортируйте проверенный ассет модели с закреплённым SHA.',checkedAt:null};
        model={...model,model:localModelAlias(model)};
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

    async start(model:IModel,onProgress:Progress=()=>{},signal?:AbortSignal):Promise<IModelVerification> {
        this.assertModel(model);
        model={...model,model:localModelAlias(model)};
        await onProgress({stage:'preparing',message:'Проверяем сохранённую модель.',progress:0});
        const existing=this.entry(await this.request('/api/tags',undefined,signal),model);
        if(existing&&!this.digestMatches(model,existing))throw new Error('SHA установленной модели отличается от закреплённой версии. Существующие веса сохранены.');
        if(!existing)throw new Error('Файлы модели не установлены из проверенного ассета. Импортируйте модель в каталоге ассетов и повторите подготовку.');
        await onProgress({stage:'checking',message:'Проверяем версию и содержательный ответ модели.',progress:90});
        const verified=await this.check(model,signal);
        await onProgress({stage:'ready',message:'Модель готова к работе.',progress:100});
        return verified;
    }

    /** Статус не подменяет проверку: здесь проверяются digest, возможности и настоящий ответ. */
    async check(model:IModel,signal?:AbortSignal):Promise<IModelVerification> {
        this.assertModel(model);
        model={...model,model:localModelAlias(model)};
        const installed=this.entry(await this.request('/api/tags',undefined,signal),model);
        if(!installed)throw new Error('Веса модели не подготовлены. Сначала запустите хостинг модели.');
        if(!this.digestMatches(model,installed))throw new Error('SHA установленной модели отличается от закреплённой версии.');
        if(typeof installed.digest!=='string'||!/^[a-f0-9]{64}$/.test(installed.digest))throw new Error('Runtime не подтвердил SHA установленной модели.');
        const metadata=await this.request('/api/show',{model:model.model},signal,30000);
        const required=model.capability==='chat'?'completion':model.capability;
        if(!Array.isArray(metadata.capabilities)||!metadata.capabilities.includes(required))throw new Error('Возможности модели не соответствуют карточке каталога.');
        const dimension=model.capability==='embedding'?await this.probeEmbedding(model,signal):null;
        if(model.capability!=='embedding')await this.probeChat(model,signal);
        const after=this.entry(await this.request('/api/tags',undefined,signal),model);
        if(!after||after.digest!==installed.digest)throw new Error('SHA модели изменился во время проверки. Повторите проверку без замены сохранённых весов.');
        return {manifestSha256:installed.digest,dimension};
    }

    /** Останавливается только выбранная модель; общие веса и соседние модели сохраняются. */
    async stop(model:IModel,signal?:AbortSignal):Promise<void> {
        this.assertModel(model);
        model={...model,model:localModelAlias(model)};
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
        const publicModel=model.model;
        model={...model,model:localModelAlias(model)};
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
        return {...value,model:publicModel};
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

    private async probeEmbedding(model:IModel,signal?:AbortSignal):Promise<number> {
        const value=await this.request('/api/embed',{model:model.model,input:['Локальная проверка базы знаний.','Local knowledge test.'],truncate:false,keep_alive:'5m'},signal,180000);
        if(value.model!==model.model||!this.validVectors(value.embeddings,2,null))throw new Error('Модель не вернула корректные ненулевые векторы ожидаемой размерности.');
        const dimension=(value.embeddings as number[][])[0].length;
        if(model.dimension!==null&&model.dimension!==dimension)throw new Error(`Размерность модели не совпадает с карточкой: ожидалась ${model.dimension}, получена ${dimension}. Проверьте карточку модели.`);
        return dimension;
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

}
