import base from '../../../core/api/base';
import type {SourceUpload,SourceUploadIntent} from './uploadTypes';
const route='/api/tool-builds/uploads';
const control={timeout:15000};
/** Raw File bodies are streamed by the browser; JSON remains a small control plane. */
export const sourceUploadApi={
 create:(body:SourceUploadIntent,signal?:AbortSignal)=>base.post<SourceUpload>(route,body,{...control,signal}).then(response=>response.data),
 lookup:(key:string,signal?:AbortSignal)=>base.get<SourceUpload>(route+'/requests/'+encodeURIComponent(key),{...control,signal}).then(response=>response.data),
 get:(id:string,signal?:AbortSignal)=>base.get<SourceUpload>(route+'/'+encodeURIComponent(id),{...control,signal}).then(response=>response.data),
 cancel:(key:string,signal?:AbortSignal)=>base.delete<SourceUpload>(route+'/requests/'+encodeURIComponent(key),{...control,signal}).then(response=>response.data),
 content:(id:string,file:File,signal:AbortSignal,onProgress:(percent:number)=>void)=>base.put<SourceUpload>(route+'/'+encodeURIComponent(id)+'/content',file,{timeout:10*60*1000,signal,headers:{'Content-Type':'application/octet-stream'},onUploadProgress:event=>onProgress(Math.min(99,Math.floor(event.loaded/file.size*100)))}).then(response=>response.data),
};
