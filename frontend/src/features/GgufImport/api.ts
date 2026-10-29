import api from '../../core/api/base';
import type {GgufImportAccept,GgufImportIntent} from './model';
const root='/api/models/gguf-imports';
const route=(id:string)=>root+'/'+encodeURIComponent(id);
export const ggufImportApi={
    limits:(signal:AbortSignal):Promise<unknown>=>api.get(root+'/limits',{signal,timeout:15000}).then(value=>value.data),
    lookup:(key:string,signal:AbortSignal):Promise<unknown>=>api.get(root+'/requests/'+encodeURIComponent(key),{signal,timeout:15000}).then(value=>value.data),
    create:(intent:GgufImportIntent,signal:AbortSignal):Promise<unknown>=>api.post(root,intent,{signal,timeout:15000}).then(value=>value.data),
    /** Browser File is the raw body. Upload progress is transport progress, not server verification. */
    upload:(id:string,file:File,signal:AbortSignal,progress:(loaded:number)=>void):Promise<unknown>=>api.put(route(id)+'/content',file,{
        signal,timeout:0,headers:{'Content-Type':'application/octet-stream'},transformRequest:[body=>body],
        onUploadProgress:event=>progress(event.loaded),
    }).then(value=>value.data),
    cancel:(id:string,signal:AbortSignal):Promise<unknown>=>api.delete(route(id),{signal,timeout:15000}).then(value=>value.data),
    accept:(id:string,input:GgufImportAccept,signal:AbortSignal):Promise<unknown>=>api.post(route(id)+'/accept',input,{signal,timeout:15000}).then(value=>value.data),
    model:(id:string,signal:AbortSignal):Promise<unknown>=>api.get('/api/models/'+encodeURIComponent(id),{signal,timeout:15000}).then(value=>value.data),
};
export type GgufImportApi=typeof ggufImportApi;
