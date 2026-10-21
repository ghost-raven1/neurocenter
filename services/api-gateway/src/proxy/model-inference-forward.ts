import type {AxiosInstance, AxiosRequestConfig, AxiosResponse} from 'axios';
import type {Request, Response} from 'express';

/** The canonical route keeps chat/embed cancellation aligned with inference permissions. */
export function modelInferenceRoute(method:string,path:string|undefined):boolean {
    return method==='POST'&&/^\/api\/models\/[^/]+\/ollama\/(?:api\/(?:chat|embed)|v1\/(?:chat\/completions|embeddings))$/.test(path||'');
}

/** Client cancellation closes Catalog's request, which in turn cancels its provider call. */
export async function forwardModelInference(http:Pick<AxiosInstance,'request'>,config:AxiosRequestConfig,req:Request,res:Response):Promise<AxiosResponse|undefined> {
    const abort=new AbortController();
    const connected=()=>!abort.signal.aborted&&!req.aborted&&!res.destroyed&&!res.writableEnded;
    const requestAborted=()=>abort.abort();
    const responseClosed=()=>{if(!res.writableEnded)abort.abort();};
    req.on('aborted',requestAborted);res.on('close',responseClosed);
    try {
        if(!connected())return;
        const response=await http.request({...config,timeout:610000,maxContentLength:8*1024*1024,signal:abort.signal});
        return connected()?response:undefined;
    } catch(error) {
        if(!abort.signal.aborted&&connected())throw error;
        return;
    } finally {
        req.removeListener('aborted',requestAborted);res.removeListener('close',responseClosed);
    }
}
