import type { AxiosInstance } from 'axios';
import type { Request,Response } from 'express';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Архив не буферизуется в gateway; закрытие клиента завершает только его upstream. */
export async function forwardRuntimeArtifact(http:AxiosInstance,catalogUrl:string,suffix:string,req:Request,res:Response):Promise<void>{
    const controller=new AbortController();const abort=()=>controller.abort();res.on('close',abort);
    try{
        const response=await http.get(`${catalogUrl}/internal/device-channel/${suffix}`,{responseType:'stream',signal:controller.signal,
            headers:{authorization:req.headers.authorization,'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||'',
                'x-neurocenter-job-lease':String(req.headers['x-neurocenter-job-lease']??'')}});
        if(response.status!==200){response.data.destroy();res.status([401,403,404,409].includes(response.status)?response.status:502).json({message:'Артефакт недоступен для текущего задания.'});return;}
        const length=Number(response.headers['content-length']);
        if(!Number.isSafeInteger(length)||length<=0||length>256*1024*1024){response.data.destroy();res.status(502).json({message:'Некорректный размер артефакта.'});return;}
        let received=0;res.setHeader('content-type','application/gzip');res.setHeader('content-length',String(length));res.setHeader('cache-control','no-store');
        await pipeline(response.data,new Transform({transform(chunk:Buffer,_encoding,callback){received+=chunk.length;callback(received>length?new Error('Превышен размер артефакта.'):null,chunk);}}),res);
    }catch{if(!res.headersSent)res.status(502).json({message:'Передача артефакта прервана. Повторите установку.'});else res.destroy();}
    finally{res.off('close',abort);}
}
