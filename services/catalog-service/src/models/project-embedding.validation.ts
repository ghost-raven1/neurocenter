import {BadRequestException,ConflictException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {IModel} from './model.types';
import {validateModelId} from './model-validation';
import type {IDeviceEmbeddingContext,IDeviceEmbeddingInput,IProjectEmbeddingUpdate} from './project-embedding.types';

const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const integer=(value:unknown,minimum=0):value is number=>Number.isSafeInteger(value)&&Number(value)>=minimum;
function body(value:unknown,allowed:string[]):Record<string,unknown>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new BadRequestException('Некорректные параметры подключения embedding-модели.');
    return value as Record<string,unknown>;
}
/** Pin зависит только от технической идентичности, а не от оформления карточки. */
export function projectEmbeddingPin(model:IModel):string {
    return createHash('sha256').update(JSON.stringify({id:model.id,runtime:model.runtime,model:model.model,
        manifestSha256:model.manifestSha256,dimension:model.dimension,capability:model.capability,
        ...(model.runtime==='ollama'?{}:{modelVersion:model.modelVersion,verificationSha256:model.verificationSha256})})).digest('hex');
}
export function assertProjectEmbeddingModel(model:IModel,dimension:number):void {
    if(model.capability!=='embedding'||!Number.isSafeInteger(dimension)||dimension<1||dimension>16000||model.dimension!==dimension
        ||(model.runtime==='ollama'?!sha(model.manifestSha256):!['remote-openai','remote-ollama'].includes(model.runtime)||!model.modelVersion||!sha(model.verificationSha256))){
        throw new ConflictException('Выберите назначенную и проверенную embedding-модель с размерностью '+dimension+'.');
    }
}
export function projectEmbeddingUpdate(value:unknown):IProjectEmbeddingUpdate {
    const input=body(value,['expectedRevision','modelId']);
    if(!integer(input.expectedRevision)||!Object.prototype.hasOwnProperty.call(input,'modelId'))throw new BadRequestException('Передайте актуальную ревизию и модель либо null для очистки.');
    return {expectedRevision:input.expectedRevision,modelId:input.modelId===null?null:validateModelId(input.modelId)};
}
export function deviceEmbeddingInput(value:unknown,inference=false):IDeviceEmbeddingContext|IDeviceEmbeddingInput {
    const input=body(value,['projectId','bindingId','instanceId','expectedRevision','expectedModelPin','installation',...(inference?['model','input']:[])]);
    if(typeof input.projectId!=='string'||!/^prj-[a-zA-Z0-9-]{1,235}$/.test(input.projectId)||!sha(input.bindingId)||!uuid(input.instanceId)
        ||(input.expectedRevision!==undefined&&!integer(input.expectedRevision,1))||(input.expectedModelPin!==undefined&&!sha(input.expectedModelPin))
        ||inference&&(!integer(input.expectedRevision,1)||!sha(input.expectedModelPin)||typeof input.model!=='string')){
        throw new BadRequestException('Нужны проект, проверенный экземпляр папки и актуальный выбор embedding-модели.');
    }
    const installation=input.installation as Record<string,unknown>|undefined;
    if(!installation||typeof installation!=='object'||Array.isArray(installation)||Object.keys(installation).sort().join(',')!=='id,kind,manifest,version'
        ||!['mcp','plugin'].includes(String(installation.kind))||typeof installation.id!=='string'||!installation.id||installation.id.length>512
        ||/[\x00-\x20\x7f]/.test(installation.id)||!integer(installation.version,1)||!sha(installation.manifest)||!integer(input.expectedRevision,1)||!sha(input.expectedModelPin))throw new BadRequestException('Нужна точная установленная версия OpenCodeRAG. Обновите мост и подключите модель заново.');
    if(inference){
        const texts=typeof input.input==='string'?[input.input]:input.input;
        if(!Array.isArray(texts)||!texts.length||texts.length>64||texts.some(text=>typeof text!=='string'||!text.trim())
            ||Buffer.byteLength(JSON.stringify(texts))>256*1024)throw new BadRequestException('Передайте от 1 до 64 непустых текстов общим размером до 256 КиБ.');
    }
    return input as unknown as IDeviceEmbeddingContext|IDeviceEmbeddingInput;
}
