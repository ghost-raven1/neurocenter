import { HttpException, ServiceUnavailableException } from '@nestjs/common';

/** Межсервисный transport передаёт только internal token и ограниченный JSON; внешних URL из тела нет. */
export class ProjectRagClient {
    private readonly base=(process.env.RAG_SERVICE_URL||'http://localhost:4300').replace(/\/+$/,'');
    async call<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
        let response:Response;
        try{response=await fetch(this.base+'/internal/project-rag/'+path,{method:body===undefined?'GET':'POST',
            headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
            ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal??AbortSignal.timeout(115000)});}
        catch{throw new ServiceUnavailableException('Сервис индексов недоступен. Результат записи будет проверен перед повтором.');}
        const reader=response.body?.getReader(),parts:Uint8Array[]=[];let size=0;
        try{if(reader)while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;
            if(size>8*1024**2){await reader.cancel();throw new ServiceUnavailableException('Ответ сервиса индексов превышает допустимый размер.');}parts.push(item.value);}}
        catch(error){if(error instanceof ServiceUnavailableException)throw error;throw new ServiceUnavailableException('Ответ сервиса индексов не подтверждён.');}
        finally{reader?.releaseLock();}
        const text=Buffer.concat(parts).toString('utf8');
        let result:unknown;try{result=JSON.parse(text);}catch{throw new ServiceUnavailableException('Сервис индексов вернул некорректный ответ.');}
        if(!response.ok){throw new HttpException(result as object,[400,403,404,409,413].includes(response.status)?response.status:503);}
        return result as T;
    }
}
