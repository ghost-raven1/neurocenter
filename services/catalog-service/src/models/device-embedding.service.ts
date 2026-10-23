import {ConflictException,ForbiddenException,HttpException,Inject,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {projectLevel} from '../access/access.model';
import {DeviceStore,type Device} from '../devices/device-store';
import {managedBinding} from '../devices/device-compatibility';
import {requireFeatureEnabled} from '../features/require-feature-enabled';
import {withModelUsage} from '../model-usage/model-usage.context';
import {ModelRuntime,type IModelInferenceRuntime} from './model-runtime';
import {HostedRagGrantService} from './hosted-rag-grant.service';
import {deviceEmbeddingInput,projectEmbeddingPin} from './project-embedding.validation';
import type {IConfiguredProjectEmbedding,IDeviceEmbeddingContext,IDeviceEmbeddingInput} from './project-embedding.types';

/** Бюджет всего device-запроса оставляет запас до опубликованного клиентского лимита 120 секунд. */
async function deviceEmbeddingDeadline<T>(caller:AbortSignal|undefined,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    caller?.throwIfAborted();
    const controller=new AbortController();
    let rejectAbort!:(reason:unknown)=>void;
    const interrupted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const aborted=()=>rejectAbort(controller.signal.reason),disconnected=()=>controller.abort(caller?.reason);
    controller.signal.addEventListener('abort',aborted,{once:true});caller?.addEventListener('abort',disconnected,{once:true});
    const timer=setTimeout(()=>{
        controller.abort(new ServiceUnavailableException('Embedding-запрос не завершился вовремя. Проверьте хостинг модели и повторите действие.'));
    },105000);timer.unref();
    try{return await Promise.race([action(controller.signal),interrupted]);}
    finally{clearTimeout(timer);caller?.removeEventListener('abort',disconnected);controller.signal.removeEventListener('abort',aborted);}
}

/** Существующий device Bearer проверяется для каждого батча; ключ не входит в настройки проекта. */
@Injectable()
export class DeviceEmbeddingService {
    constructor(private readonly devices:DeviceStore,@Inject(ModelRuntime) private readonly runtime:IModelInferenceRuntime,private readonly grants:HostedRagGrantService){}
    private async current(device:Device,input:IDeviceEmbeddingContext,signal?:AbortSignal):Promise<IConfiguredProjectEmbedding>{
        signal?.throwIfAborted();
        const live=await this.devices.owned({email:device.email,activeRole:device.role},device.id);signal?.throwIfAborted();
        const claims=await this.devices.access.claims(live.email);signal?.throwIfAborted();
        if(live.role!==device.role||!claims.userRoles.includes(live.role)||projectLevel(claims,live.role,input.projectId)<2){
            throw new ForbiddenException('Для embedding-запроса нужна актуальная рабочая роль в этом проекте.');
        }
        const project=await this.devices.pool.query('SELECT id FROM projects WHERE id=$1',[input.projectId]);signal?.throwIfAborted();
        if(!project.rows.length)throw new NotFoundException('Проект удалён.');
        const binding=Array.isArray(live.report.bindings)?live.report.bindings.find(item=>item?.projectId===input.projectId):undefined;
        if(managedBinding(live.report,input.projectId)!==input.bindingId||binding?.instanceId!==input.instanceId){
            throw new ConflictException('Папка или экземпляр проекта изменились. Перечитайте подключение embedding-модели.');
        }
        const selected=await this.grants.require(live,input);signal?.throwIfAborted();return selected;
    }
    context(device:Device,value:unknown):Promise<IConfiguredProjectEmbedding>{
        return this.current(device,deviceEmbeddingInput(value) as IDeviceEmbeddingContext);
    }
    async embed(device:Device,value:unknown,signal?:AbortSignal){
        return deviceEmbeddingDeadline(signal,async signal=>{
            const input=deviceEmbeddingInput(value,true) as IDeviceEmbeddingInput;
            const selected=await this.current(device,input,signal);
            if(input.model!==selected.profile.model)throw new ConflictException('Запрос относится к другому закреплённому профилю модели.');
            await requireFeatureEnabled('model_hosting');signal.throwIfAborted();
            const texts=typeof input.input==='string'?[input.input]:input.input;
            let result:Record<string,unknown>;
            const beforeInference=async()=>{
                const current=await this.current(device,input,signal);
                if(projectEmbeddingPin(current.model)!==projectEmbeddingPin(selected.model))throw new ConflictException('Закреплённая модель изменилась. Перечитайте подключение.');
                signal.throwIfAborted();
            };
            try{result=await withModelUsage({purpose:'device-embedding',actorEmail:device.email,projectId:input.projectId,beforeInference},()=>this.runtime.infer(selected.model,'embed',{input:texts,truncate:false},signal));}
            catch(cause){signal.throwIfAborted();if(cause instanceof HttpException)throw cause;throw new ServiceUnavailableException('Модель не выполнила embedding-запрос. Проверьте хостинг и повторите действие.');}
            // Отзыв прав, назначения или папки во время inference не отдаёт векторы старому подключению.
            signal.throwIfAborted();await this.current(device,input,signal);
            const vectors=result.embeddings;
            if(!Array.isArray(vectors)||vectors.length!==texts.length||vectors.some(vector=>!Array.isArray(vector)||vector.length!==selected.expectedDimension
                ||!vector.some(value=>Math.fround(value)!==0)||vector.some(value=>typeof value!=='number'||!Number.isFinite(Math.fround(value))))){
                throw new ServiceUnavailableException('Модель вернула неполные или несовместимые векторы.');
            }
            const tokens=Number.isSafeInteger(result.prompt_eval_count)&&Number(result.prompt_eval_count)>=0?Number(result.prompt_eval_count):0;
            return {object:'list',model:selected.profile.model,data:vectors.map((embedding,index)=>({object:'embedding',index,embedding})),
                usage:{prompt_tokens:tokens,total_tokens:tokens}};
        });
    }
}
