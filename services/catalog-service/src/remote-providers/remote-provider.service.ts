import {BadRequestException,Injectable,OnApplicationShutdown} from '@nestjs/common';
import type {Request} from 'express';
import {createPool} from '../database/pool';
import {ModelsService} from '../models/models.service';
import type {IModel} from '../models/model.types';
import type {IRemoteConnectionRow} from '../models/remote-connection.repository';
import {currentModelUsage} from '../model-usage/model-usage.context';
import {RemoteProviderRepository} from './remote-provider.repository';
import {remoteProviderMutation} from './remote-provider.identity';
import {remoteProviderLease} from './remote-provider.lease';

/** Personal settings never become model descriptors, prompts, exported assets or global model health. */
@Injectable()
export class RemoteProviderAccessService implements OnApplicationShutdown {
    readonly repository:RemoteProviderRepository;
    private readonly leases;
    constructor(private readonly models:ModelsService){
        this.repository=new RemoteProviderRepository(models.pool);
        this.leases=createPool({...models.pool.options,max:2,connectionTimeoutMillis:800,query_timeout:1200},'personal-provider-wire');
    }
    async onApplicationShutdown():Promise<void>{await this.leases.end();}
    async read(req:Request,id:string){
        const actor=await this.models.actor(req),model=await this.models.getAccessible(id,req),value=await this.repository.view(model,actor);
        await this.models.getAccessible(id,req);return value;
    }
    async receipt(req:Request,id:string,key:string){
        if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(key))throw new BadRequestException('Нужен ключ сохранения личного доступа.');
        const actor=await this.models.actor(req);await this.models.getAccessible(id,req);
        const value=await this.repository.receipt(id,actor,key);await this.models.getAccessible(id,req);return value;
    }
    async mutate(req:Request,id:string,raw:unknown,action:'save'|'delete'){
        const input=remoteProviderMutation(raw,action),actor=await this.models.actor(req),model=await this.models.getAccessible(id,req);
        const value=await this.repository.mutate(model,actor,input,action);
        await this.models.getAccessible(id,req);return value;
    }
    wire(model:IModel,row:IRemoteConnectionRow){
        const context=currentModelUsage();
        return {acquire:(signal?:AbortSignal)=>remoteProviderLease(this.leases,model,row,{email:context.actorEmail??'',activeRole:context.actorRole??'',projectId:context.projectId},signal)};
    }
}
