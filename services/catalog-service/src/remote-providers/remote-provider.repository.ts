import {BadRequestException,ConflictException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import type {IModel} from '../models/model.types';
import {isRemoteModel} from '../models/remote-model.types';
import type {IRemoteConnectionRow} from '../models/remote-connection.repository';
import {canStoreModelCredential} from '../models/remote-model-secret';
import {requireFeatureEnabled} from '../features/require-feature-enabled';
import {securityEvent} from '../access/security-events';
import {remoteProviderAuthority} from './remote-provider.authority';
import {credentialFence,remoteAuthMode,remoteMutationHash,remoteProviderId,sealUserCredential} from './remote-provider.identity';
import type {RemoteProviderAccessView,RemoteProviderActor,RemoteProviderMutation,RemoteProviderReceipt,RemoteUserCredentialRow} from './remote-provider.types';

type Db=Pick<PoolClient,'query'>;
export async function providerConnection(db:Db,modelId:string,revision?:number):Promise<IRemoteConnectionRow>{
    const row=(await db.query<IRemoteConnectionRow>(`SELECT * FROM model_remote_connections WHERE model_id=$1 ${revision===undefined?'ORDER BY revision DESC LIMIT 1':'AND revision=$2'} FOR SHARE`,revision===undefined?[modelId]:[modelId,revision])).rows[0];
    if(!row||row.revoked_at)throw new ConflictException('Сначала настройте действующее подключение провайдера модели.');
    return row;
}
export const readUserCredential=async(db:Db,modelId:string,providerId:string,email:string):Promise<RemoteUserCredentialRow|undefined>=>
    (await db.query<RemoteUserCredentialRow>('SELECT * FROM remote_provider_user_credentials WHERE model_id=$1 AND provider_id=$2 AND owner_email=$3 FOR SHARE',[modelId,providerId,email])).rows[0];

/** The current ciphertext is replaceable; receipts carry only masked identity and CAS revisions. */
export class RemoteProviderRepository {
    constructor(private readonly pool:Pool,private readonly environment:NodeJS.ProcessEnv=process.env){}
    async view(model:IModel,actor:RemoteProviderActor):Promise<RemoteProviderAccessView>{
        return this.transaction(async db=>{
            await remoteProviderAuthority(db,actor,model.id);
            if(!isRemoteModel(model))throw new BadRequestException('Личный API-ключ задаётся для удалённого провайдера.');
            const connection=await providerConnection(db,model.id),providerId=remoteProviderId(model,connection);
            const credential=await readUserCredential(db,model.id,providerId,actor.email);
            return {modelId:model.id,providerId,providerUrl:connection.base_url,connectionRevision:Number(connection.revision),authMode:remoteAuthMode(connection),
                credentialRevision:credential?.revision??0,hasKey:!!credential?.credential,updatedAt:credential?new Date(credential.updated_at).toISOString():null,
                canStoreKey:canStoreModelCredential(this.environment),legacySharedKeyRetained:connection.credential_kind!=='none'};
        });
    }
    async receipt(modelId:string,actor:RemoteProviderActor,key:string):Promise<RemoteProviderReceipt|null>{
        return this.transaction(async db=>{
            await remoteProviderAuthority(db,actor,modelId);
            const row=(await db.query<{model_id:string;result:RemoteProviderReceipt}>('SELECT model_id,result FROM remote_provider_user_requests WHERE owner_email=$1 AND request_key=$2',[actor.email,key])).rows[0];
            return row?.model_id===modelId?row.result:null;
        });
    }
    async mutate(model:IModel,actor:RemoteProviderActor,input:RemoteProviderMutation,action:'save'|'delete'):Promise<RemoteProviderReceipt>{
        if(!isRemoteModel(model))throw new BadRequestException('Выберите удалённую модель.');
        const hash=remoteMutationHash(model.id,actor.email,action,input,this.environment);
        return this.transaction(async db=>{
            await remoteProviderAuthority(db,actor,model.id);
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[credentialFence(actor.email,input.providerId)]);
            const prior=(await db.query<{model_id:string;request_hash:string;result:RemoteProviderReceipt}>('SELECT model_id,request_hash,result FROM remote_provider_user_requests WHERE owner_email=$1 AND request_key=$2',[actor.email,input.requestKey])).rows[0];
            if(prior){if(prior.model_id!==model.id||prior.request_hash!==hash)throw new ConflictException('Ключ повтора относится к другой настройке личного доступа.');return prior.result;}
            await requireFeatureEnabled('personal_remote_provider_credentials');
            const connection=await providerConnection(db,model.id);
            if(Number(connection.revision)!==input.expectedConnectionRevision||remoteProviderId(model,connection)!==input.providerId)
                throw new ConflictException('Провайдер изменился. Обновите сведения; API-ключ остался в форме.');
            const current=await readUserCredential(db,model.id,input.providerId,actor.email);
            if((current?.revision??0)!==input.expectedCredentialRevision)throw new ConflictException('Личный ключ уже изменён. Обновите сведения перед сохранением.');
            const revision=(current?.revision??0)+1;
            if(!Number.isSafeInteger(revision)||revision>2147483647)throw new ConflictException('Ревизия личного доступа исчерпана.');
            const secret=action==='save'?sealUserCredential(input.apiKey!,actor.email,input.providerId,revision,this.environment):null;
            const row=(await db.query<{updated_at:string|Date}>(`INSERT INTO remote_provider_user_credentials(model_id,provider_id,owner_email,revision,credential)
                VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(model_id,provider_id,owner_email) DO UPDATE SET revision=EXCLUDED.revision,credential=EXCLUDED.credential,updated_at=clock_timestamp() RETURNING updated_at`,
                [model.id,input.providerId,actor.email,revision,secret?JSON.stringify(secret):null])).rows[0];
            const result:RemoteProviderReceipt={modelId:model.id,providerId:input.providerId,requestKey:input.requestKey,requestHash:hash,connectionRevision:Number(connection.revision),
                credentialRevision:revision,hasKey:!!secret,acceptedAt:new Date(row.updated_at).toISOString()};
            await db.query('INSERT INTO remote_provider_user_requests(owner_email,request_key,model_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',[actor.email,input.requestKey,model.id,hash,JSON.stringify(result)]);
            await securityEvent(db,{actor:actor.email,action:'model.personal-key.'+action,resourceId:model.id,before:{credentialRevision:current?.revision??0},after:{providerId:input.providerId,credentialRevision:revision,hasKey:!!secret}});
            return result;
        });
    }
    private async transaction<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{
        const db=await this.pool.connect();let discard=false;
        try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='1s'");await db.query("SET LOCAL statement_timeout='3s'");const result=await work(db);await db.query('COMMIT');return result;}
        catch(error){await db.query('ROLLBACK').catch(()=>{discard=true;});throw error;}finally{db.release(discard);}
    }
}
