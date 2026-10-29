import {discussionAttachmentUploadRoute} from '../../../shared/discussion-attachment-route.cjs';
import {ggufImportContentRoute} from '../../../shared/gguf-import-route.cjs';
import {snapshotContentRoute} from '../../../shared/snapshot-content-route.cjs';
import type {AxiosInstance} from 'axios';
import type {Request,Response} from 'express';
import {Transform} from 'node:stream';
import {sourceUploadContentRoute} from '../../../shared/source-upload-route.cjs';
import {assetSourceArchiveRoute} from '../../../shared/asset-source-archive-route.cjs';

const defaultMaximum=256*1024**2;
/** Raw upload refusals can precede body consumption, so each request owns its HTTP connection. */
export function sourceUploadConnection(req:Request,res:Response,next:()=>void):void{
 if(ggufImportContentRoute(req.method,req.path)||discussionAttachmentUploadRoute(req.method,req.path)||sourceUploadContentRoute(req.method,req.path)||snapshotContentRoute(req.method,req.path)||assetSourceArchiveRoute(req.method,req.path))res.setHeader('Connection','close');
 next();
}
/** Bounded raw stream preserves backpressure and aborts the catalog transfer when the browser disconnects. */
export async function forwardSourceUpload(http:AxiosInstance,url:string,headers:Record<string,string>,req:Request,res:Response,maximum=defaultMaximum,responseMaximum=1024*1024,method:'PUT'|'POST'='PUT',timeoutMs=10*60*1000):Promise<void>{
 if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/octet-stream'){res.setHeader('Connection','close');res.status(415).json({message:'Передайте файл потоком application/octet-stream.'});return;}
 const limitLabel=String(maximum/1024**2)+' МиБ';
 const declared=req.headers['content-length'];
 if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)<1||Number(declared)>maximum)){res.setHeader('Connection','close');res.status(413).json({message:'Файл должен занимать от 1 байта до '+limitLabel+'.'});return;}
 const controller=new AbortController();let bytes=0,tooLarge=false,timedOut=false;
 const stream=new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(bytes>maximum){tooLarge=true;done(new Error('upload-byte-limit'));return;}done(null,chunk);}});
 const disconnected=()=>controller.abort(),closed=()=>{if(!res.writableEnded)controller.abort();},broken=()=>controller.abort();
 req.on('aborted',disconnected);res.on('close',closed);stream.on('error',broken);
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);timer.unref();
 try{
  if(req.aborted||res.destroyed){controller.abort();return;}
  req.pipe(stream);
  const response=await http.request({method,url,data:stream,headers:{...headers,'content-type':'application/octet-stream',...(declared?{'content-length':declared}:{})},
   timeout:timeoutMs,maxBodyLength:maximum,maxContentLength:responseMaximum,maxRedirects:0,responseType:'json',validateStatus:()=>true,signal:controller.signal});
  req.unpipe(stream);stream.destroy();
  if(res.destroyed||req.aborted)return;
  // Early catalog refusals close the input connection after the small response is flushed.
  if(!req.complete)res.setHeader('Connection','close');
  res.setHeader('Cache-Control','no-store');
  const data=response.data;
  res.status(response.status).json(data&&typeof data==='object'&&!Array.isArray(data)?data:{message:'Каталог вернул некорректный ответ загрузки.'});
 }catch{
  if(res.destroyed||req.aborted)return;
  if(!req.complete)res.setHeader('Connection','close');
  res.status(tooLarge?413:timedOut?504:502).json({message:tooLarge?'Файл превышает '+limitLabel+'.':timedOut?'Истекло время загрузки. Проверьте её состояние и повторите тот же файл.':'Передача прервана. Проверьте состояние сохранённой загрузки.'});
 }finally{clearTimeout(timer);req.unpipe(stream);stream.destroy();req.off('aborted',disconnected);res.off('close',closed);stream.off('error',broken);}
}
