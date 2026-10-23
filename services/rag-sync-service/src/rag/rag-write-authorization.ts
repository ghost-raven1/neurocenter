import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {validRagWriteGrant,ragWriteAdmissionUncertain,type RagWriteAuthorizationPhase} from '../../../shared/rag-write-authorization.cjs';
import type {IProjectRagContext} from './project-rag-context';

/** Every first mutation asks Catalog afresh; grants are neither cached nor persisted for a later retry. */
export async function authorizeRagWrite(value:{id:string;payloadHash:string;context:IProjectRagContext},phase:RagWriteAuthorizationPhase):Promise<void>{
    const base=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/+$/,'');
    let response:Response,body:unknown;
    try{
        response=await fetch(base+'/internal/project-rag/write-authorize',{method:'POST',redirect:'error',
            headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
            body:JSON.stringify({...value,phase}),signal:AbortSignal.timeout(8000)});
        body=await response.json();
    }catch{throw new ServiceUnavailableException('Каталог пока не подтвердил intent записи. Повтор использует тот же пакет.');}
    if(!response.ok){
        if(response.status===403&&ragWriteAdmissionUncertain(body))throw new ForbiddenException(body as object);
        throw new ServiceUnavailableException('Каталог пока не подтвердил intent записи. Повтор использует тот же пакет.');
    }
    if(!validRagWriteGrant(body,phase))throw new ServiceUnavailableException('Обновите Catalog и RAG одновременно: разрешение записи не содержит проверяемую фазу.');
}
