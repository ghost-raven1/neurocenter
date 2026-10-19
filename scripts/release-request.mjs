import {setTimeout as wait} from 'node:timers/promises';

const temporaryStatuses=new Set([408,429,500,502,503,504]);

function retryDelay(response,attempt) {
    const header=response?.headers.get('retry-after');
    if(header!==null&&header!==undefined) {
        const milliseconds=/^\d+$/.test(header.trim())?Number(header)*1000:Date.parse(header)-Date.now();
        if(Number.isFinite(milliseconds))return Math.min(5000,Math.max(0,milliseconds));
    }
    return 250*2**attempt;
}

/** Три попытки GET до записи файла: временные ответы освобождаются, отмена прерывает ожидание. */
export async function requestRelease(url,request,{signal}={}) {
    for(let attempt=0;attempt<3;attempt++) {
        signal?.throwIfAborted();
        let response;
        try {response=await request(url,{redirect:'manual',signal});}
        catch(error) {
            signal?.throwIfAborted();
            if(error?.name!=='TypeError'||attempt===2)throw error;
            await wait(retryDelay(undefined,attempt),undefined,{signal});
            continue;
        }
        if(signal?.aborted) {
            await response.body?.cancel().catch(()=>undefined);
            signal.throwIfAborted();
        }
        if(!temporaryStatuses.has(response.status)||attempt===2)return response;
        const delay=retryDelay(response,attempt);
        await response.body?.cancel().catch(()=>undefined);
        await wait(delay,undefined,{signal});
    }
}
