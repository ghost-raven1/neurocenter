import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import type {TextActor} from './text-values';

/** Fresh Catalog authorization runs inside the locked transaction, immediately before its first mutation. */
export async function authorizeTextUpload(value:{projectId:string;actor:TextActor;requestKey:string;requestHash:string}):Promise<void>{
    const base=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/+$/,'');
    let response:Response,body:unknown;
    try{
        response=await fetch(base+'/internal/project-text/authorize',{method:'POST',redirect:'error',
            headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
            body:JSON.stringify(value),signal:AbortSignal.timeout(8000)});
        body=await response.json();
    }catch{throw new ServiceUnavailableException('Каталог пока не подтвердил загрузку текстов. Повторите тот же пакет.');}
    if(response.status===403)throw new ForbiddenException('Права на загрузку текстов изменились.');
    if(!response.ok||!body||typeof body!=='object'||(body as {ok?:unknown}).ok!==true){
        throw new ServiceUnavailableException('Каталог пока не подтвердил загрузку текстов. Повторите тот же пакет.');
    }
}
