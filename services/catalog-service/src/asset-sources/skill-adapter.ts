import { ConflictException, ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { toSkillCreate, type ResolvedAsset, type SkillAsset } from '@neurocenter/asset-contract';
import type { IImportItem, INativeAssetPin, ISourceReceipt } from './import-types';
import { importDependencyContext } from './tool-adapter';
import {normalizeEmail} from '../access/access.model';

export interface ISkillSnapshot extends INativeAssetPin {name?:string;archivedAt?:string;payloadHash?:string;importRequestKey?:string;archive?:{requestKey:string;previousHash:string;payloadHash:string;version:number;restore:boolean}}
/** Только internal gateway-to-service вызовы; браузер не задаёт target URL или исполнителя. */
export class SkillAssetClient {
    constructor(private readonly request:typeof fetch=fetch) {}
    async call<T>(method:string,body?:unknown):Promise<T> {
        const token=process.env.NEUROCENTER_INTERNAL_TOKEN;
        if(!token){throw new ServiceUnavailableException('Внутреннее соединение каталога со скиллами не настроено.');}
        let response:Response;
        try{response=await this.request((process.env.SKILLS_SERVICE_URL||'http://localhost:4200').replace(/\/$/,'')+'/internal/asset-sources/skills/'+method,
            {method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-neurocenter-internal':token},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30_000)});}
        catch{throw new ServiceUnavailableException('Сервис скиллов не подтвердил ответ. Повтор безопасно проверит сохранённую версию.');}
        let value:unknown;try{value=await response.json();}catch{throw new ServiceUnavailableException('Сервис скиллов вернул неподдерживаемый ответ.');}
        if(!response.ok){const message=(value as {message?:unknown})?.message;throw new HttpException(typeof message==='string'?message:'Сервис скиллов отклонил операцию.',[400,404,409].includes(response.status)?response.status:503);}
        return value as T;
    }
    inspect(id:string):Promise<ISkillSnapshot>{return this.call('inspect',{id});}
}
export class SkillAssetAdapter {
    constructor(readonly client=new SkillAssetClient()) {}
    async preview(resolved:ResolvedAsset,key:string,planned:IImportItem[],receipt?:ISourceReceipt,versionReceipt?:ISourceReceipt,overrideHash?:string):Promise<IImportItem>{
        const asset=resolved.asset as SkillAsset,input=toSkillCreate(asset,importDependencyContext(asset,planned));
        const result=await this.client.call<{input:Record<string,unknown>;payloadHash:string;current:ISkillSnapshot|null}>('preview',{input});
        const base:IImportItem={resolved,requestKey:key,name:asset.card.name,action:'create',state:'PENDING',payload:result.input};
        const current=result.current;
        const approved=!!current&&overrideHash===current.hash;
        if(overrideHash&&!approved){return {...base,action:'conflict',reason:'Скилл изменился после подтверждения замены. Проверьте конфликт заново.'};}
        if(receipt&&!approved&&(!current||receipt.asset_kind!=='skill'||current.id!==receipt.native_id||current.hash!==receipt.native_hash)){
            return {...base,action:'conflict',expected:current??undefined,replaceable:!!current&&resolved.current,reason:'Инструкция изменена локально. Можно сохранить её или явно заменить содержимым источника; прежние версии и ресурсы сохранятся.'};
        }
        if(current?.archivedAt){return {...base,action:'conflict',reason:'Скилл находится в архиве. Сначала верните его в каталог.'};}
        if(versionReceipt&&versionReceipt.descriptor_sha256!==resolved.sha256){return {...base,action:'conflict',reason:'Опись известной версии скилла переписана.'};}
        if(current&&current.payloadHash!==result.payloadHash&&!receipt&&!approved){return {...base,action:'conflict',expected:current??undefined,replaceable:!!current&&resolved.current,reason:'Путь занят локальной инструкцией. Её можно сохранить или явно заменить содержимым источника.'};}
        // Исторический FS snapshot пока требует отдельной записи через native history; не имитируем head downgrade.
        if(current&&!resolved.current&&current.payloadHash!==result.payloadHash){return {...base,action:'conflict',reason:'Историческая версия скилла не является допустимой runtime-зависимостью. Выберите текущую инструкцию.'};}
        const unchanged=current?.payloadHash===result.payloadHash;
        return {...base,replacesLocal:approved,action:current?(unchanged?'unchanged':'update'):'create',expected:current??undefined,
            native:current??{kind:'skill',id:'common/'+asset.card.slug,version:1,hash:result.payloadHash}};
    }
    async publish(item:IImportItem,actor:string):Promise<INativeAssetPin>{
        if(item.action==='conflict'||!item.payload){throw new ConflictException('План не разрешает публикацию скилла.');}
        let email:string;try{email=normalizeEmail(actor);}catch{throw new ForbiddenException('Требуется действующая почта исполнителя импорта.');}
        return this.client.call<INativeAssetPin>('publish',{input:item.payload,requestKey:item.requestKey,actor:email,
            ...(item.expected?{expected:{id:item.expected.id,version:item.expected.version,hash:item.expected.hash}}:{})});
    }
}
