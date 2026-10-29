import type {AxiosInstance} from 'axios';
import type {Request,Response} from 'express';
import {forwardSourceUpload} from './source-upload-stream';

/** The authenticated durable receipt owns limits even after the administrator changes policy. */
export async function forwardGgufImport(http:AxiosInstance,url:string,headers:Record<string,string>,req:Request,res:Response):Promise<void>{
 res.setHeader('Connection','close');res.setHeader('Cache-Control','no-store');
 try{
  const receipt=await http.get(url.replace(/\/content$/,''),{headers,maxContentLength:1024*1024,maxRedirects:0,validateStatus:()=>true});
  if(receipt.status!==200){res.status(receipt.status).json(receipt.data);return;}
  const {bytes,limits}=receipt.data||{};
  if(!Number.isSafeInteger(bytes)||bytes<1||!Number.isSafeInteger(limits?.maximumBytes)||bytes>limits.maximumBytes||!Number.isSafeInteger(limits?.uploadTimeoutMs)||limits.uploadTimeoutMs<1||limits.uploadTimeoutMs>2147483647){res.status(502).json({message:'Каталог не подтвердил лимиты выбранного импорта.'});return;}
  await forwardSourceUpload(http,url,headers,req,res,bytes,1024*1024,'PUT',limits.uploadTimeoutMs);
 }catch{if(!res.destroyed&&!res.headersSent)res.status(502).json({message:'Не удалось проверить квитанцию GGUF. Повторите после восстановления каталога.'});}
}
