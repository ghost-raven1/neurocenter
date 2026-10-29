import {ConflictException,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import type {IModel} from '../models/model.types';
import type {IRemoteConnectionRow} from '../models/remote-connection.repository';
import type {ProviderWireLease} from '../model-usage/model-usage.context';
import {requireFeatureEnabled} from '../features/require-feature-enabled';
import {remoteProviderAuthority} from './remote-provider.authority';
import {credentialFence,openUserCredential,remoteAuthMode,remoteProviderId} from './remote-provider.identity';
import {providerConnection,readUserCredential} from './remote-provider.repository';
import type {RemoteProviderActor} from './remote-provider.types';

/** A dedicated short SQL lease holds fresh ACL/provider/key until the literal fetch invocation. */
export async function remoteProviderLease(pool:Pool,model:IModel,expected:IRemoteConnectionRow,actor:RemoteProviderActor,signal?:AbortSignal,environment:NodeJS.ProcessEnv=process.env):Promise<ProviderWireLease>{
    signal?.throwIfAborted();await requireFeatureEnabled('personal_remote_provider_credentials');signal?.throwIfAborted();
    let db:PoolClient|undefined,released=false,valid=true,releasePromise:Promise<void>|undefined;
    const unavailable=()=>new ServiceUnavailableException('Не удалось подтвердить личный доступ перед отправкой. Запрос провайдеру не отправлен.');
    const destroy=()=>{valid=false;cleanup();if(db&&!released){released=true;db.release(true);}};
    const timer=setTimeout(destroy,4000);timer.unref();signal?.addEventListener('abort',destroy,{once:true});
    const assertCurrent=()=>{signal?.throwIfAborted();if(!valid||released)throw unavailable();};
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',destroy);db?.removeListener('error',destroy);db?.removeListener('end',destroy);};
    const release=():Promise<void>=>releasePromise??=(async()=>{
        valid=false;clearTimeout(timer);signal?.removeEventListener('abort',destroy);if(!db||released){cleanup();return;}released=true;
        try{await db.query('COMMIT');db.release();}catch{db.release(true);}finally{cleanup();}
    })();
    try{
        db=await pool.connect();db.on('error',destroy);db.on('end',destroy);assertCurrent();
        await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='500ms'");await db.query("SET LOCAL statement_timeout='1s'");
        const currentActor=await remoteProviderAuthority(db,actor,model.id,true);assertCurrent();
        const row=await providerConnection(db,model.id,Number(expected.revision));
        if(row.base_url!==expected.base_url||row.semantic_sha!==expected.semantic_sha||row.auth_mode!==expected.auth_mode)
            throw new ConflictException('Подключение провайдера изменилось. Повторите действие.');
        const mode=remoteAuthMode(row),providerId=remoteProviderId(model,row);
        await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[credentialFence(currentActor.email,providerId)]);assertCurrent();
        const credential=mode==='none'?undefined:await readUserCredential(db,model.id,providerId,currentActor.email);assertCurrent();
        if(mode==='required'&&!credential?.credential)throw new ForbiddenException({code:'PERSONAL_PROVIDER_KEY_REQUIRED',modelId:model.id,providerId,message:'Настройте «Мой доступ» к провайдеру этой модели: нужен ваш API-ключ.'});
        const apiKey=credential?.credential?openUserCredential(credential.credential,currentActor.email,providerId,credential.revision,environment):undefined;
        assertCurrent();return{apiKey,assertCurrent,release};
    }catch(error){cleanup();destroy();signal?.throwIfAborted();if(error instanceof ForbiddenException||error instanceof ConflictException||error instanceof ServiceUnavailableException)throw error;throw unavailable();}
}
