import {ConflictException,ForbiddenException,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {projectLevel} from '../access/access.model';
import {DeviceStore,type Device} from '../devices/device-store';
import {managedBinding} from '../devices/device-compatibility';
import {requireFeatureEnabled} from '../features/require-feature-enabled';
import {OllamaClient} from './ollama-client';
import {ProjectEmbeddingService} from './project-embedding.service';
import {deviceEmbeddingInput} from './project-embedding.validation';
import type {IConfiguredProjectEmbedding,IDeviceEmbeddingContext,IDeviceEmbeddingInput} from './project-embedding.types';

/** Существующий device Bearer проверяется для каждого батча; ключ не входит в настройки проекта. */
@Injectable()
export class DeviceEmbeddingService {
    constructor(private readonly devices:DeviceStore,private readonly selection:ProjectEmbeddingService,private readonly runtime:OllamaClient){}
    private async current(device:Device,input:IDeviceEmbeddingContext):Promise<IConfiguredProjectEmbedding>{
        const live=await this.devices.owned({email:device.email,activeRole:device.role},device.id);
        const claims=await this.devices.access.claims(live.email);
        if(live.role!==device.role||!claims.userRoles.includes(live.role)||projectLevel(claims,live.role,input.projectId)<2){
            throw new ForbiddenException('Для embedding-запроса нужна актуальная рабочая роль в этом проекте.');
        }
        if(!(await this.devices.pool.query('SELECT id FROM projects WHERE id=$1',[input.projectId])).rows.length)throw new NotFoundException('Проект удалён.');
        const binding=Array.isArray(live.report.bindings)?live.report.bindings.find(item=>item?.projectId===input.projectId):undefined;
        if(managedBinding(live.report,input.projectId)!==input.bindingId||binding?.instanceId!==input.instanceId){
            throw new ConflictException('Папка или экземпляр проекта изменились. Перечитайте подключение embedding-модели.');
        }
        return this.selection.requireCurrent(input.projectId,input.expectedRevision,input.expectedModelPin);
    }
    context(device:Device,value:unknown):Promise<IConfiguredProjectEmbedding>{
        return this.current(device,deviceEmbeddingInput(value) as IDeviceEmbeddingContext);
    }
    async embed(device:Device,value:unknown,signal?:AbortSignal){
        const input=deviceEmbeddingInput(value,true) as IDeviceEmbeddingInput;
        const selected=await this.current(device,input);
        if(input.model!==selected.profile.model)throw new ConflictException('Запрос относится к другому закреплённому профилю модели.');
        await requireFeatureEnabled('model_hosting');signal?.throwIfAborted();
        const texts=typeof input.input==='string'?[input.input]:input.input;
        let result:Record<string,unknown>;
        try{result=await this.runtime.infer(selected.model,'embed',{input:texts,truncate:false},signal);}
        catch{throw new ServiceUnavailableException('Модель не выполнила embedding-запрос. Проверьте хостинг и повторите действие.');}
        // Отзыв прав, назначения или папки во время inference не отдаёт векторы старому подключению.
        await this.current(device,input);signal?.throwIfAborted();
        const vectors=result.embeddings;
        if(!Array.isArray(vectors)||vectors.length!==texts.length||vectors.some(vector=>!Array.isArray(vector)||vector.length!==selected.expectedDimension
            ||!vector.some(value=>Math.fround(value)!==0)||vector.some(value=>typeof value!=='number'||!Number.isFinite(Math.fround(value))))){
            throw new ServiceUnavailableException('Модель вернула неполные или несовместимые векторы.');
        }
        const tokens=Number.isSafeInteger(result.prompt_eval_count)&&Number(result.prompt_eval_count)>=0?Number(result.prompt_eval_count):0;
        return {object:'list',model:selected.profile.model,data:vectors.map((embedding,index)=>({object:'embedding',index,embedding})),
            usage:{prompt_tokens:tokens,total_tokens:tokens}};
    }
}
