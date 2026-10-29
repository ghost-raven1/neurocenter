import {ServiceUnavailableException} from '@nestjs/common';
import {runtimeLimitPolicy} from '../../../shared/runtime-limits.cjs';
import type {TextAdmission} from '../../../shared/project-text-knowledge.cjs';

/** A new operation reads current Catalog policy; state and committed receipt reads do not depend on it. */
export async function readTextAdmission():Promise<TextAdmission>{
    try{
        const base=new URL(process.env.CATALOG_SERVICE_URL||'http://localhost:4100');
        if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error('invalid configuration');
        const response=await fetch(base.href.replace(/\/+$/,'')+'/internal/runtime-limits',{redirect:'error',headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw new Error('unavailable');
        const parts:Uint8Array[]=[];let bytes=0;
        if(!response.body)throw new Error('empty');
        for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>32768)throw new Error('oversize');parts.push(chunk);}
        const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
        if(!Number.isSafeInteger(value?.revision)||value.revision<0)throw new Error('invalid revision');
        return {revision:value.revision,limits:runtimeLimitPolicy(value.policy).textKnowledge};
    }catch{throw new ServiceUnavailableException('Действующие лимиты текста недоступны. Повторите запрос; сохранённые квитанции доступны отдельно.');}
}
