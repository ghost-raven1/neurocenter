import type {AxiosInstance,AxiosRequestConfig,AxiosResponse} from 'axios';
import type {Request,Response} from 'express';
import {TOOL_IMPORT_GATEWAY_TIMEOUT_MS} from '../../../shared/tool-import-deadline.cjs';

/** A caller disconnect closes only its import request, so Catalog can stop before publication. */
export async function forwardToolImport(http:Pick<AxiosInstance,'request'>,config:AxiosRequestConfig,req:Request,res:Response):Promise<AxiosResponse|undefined>{
    const abort=new AbortController(),connected=()=>!abort.signal.aborted&&!req.aborted&&!res.destroyed&&!res.writableEnded;
    const requestAborted=()=>abort.abort(),responseClosed=()=>{if(!res.writableEnded)abort.abort();};
    req.on('aborted',requestAborted);res.on('close',responseClosed);
    try{
        if(!connected())return;
        const response=await http.request({...config,timeout:TOOL_IMPORT_GATEWAY_TIMEOUT_MS,signal:abort.signal});
        return connected()?response:undefined;
    }catch(error){if(connected())throw error;return;}
    finally{req.off('aborted',requestAborted);res.off('close',responseClosed);}
}
