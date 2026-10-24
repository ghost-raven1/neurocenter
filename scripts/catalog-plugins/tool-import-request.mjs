import http from 'node:http';
import https from 'node:https';
import {TOOL_IMPORT_CLIENT_TIMEOUT_MS} from '../../services/shared/tool-import-deadline.cjs';

/** Native HTTP avoids fetch's independent five-minute headers limit for the synchronous import. */
export function requestToolImport(url,{headers,body,signal}){
    return new Promise((resolve,reject)=>{
        const deadline=new AbortController(),requestSignal=AbortSignal.any([deadline.signal,...(signal?[signal]:[])]);
        const transport=new URL(url).protocol==='https:'?https:http;
        const request=transport.request(url,{method:'POST',headers,signal:requestSignal},response=>{
            const chunks=[];let bytes=0;
            response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024**2){response.destroy(new Error('Ответ импорта превышает 1 МиБ.'));return;}chunks.push(chunk);});
            response.once('error',reject);
            response.once('end',()=>{
                try{
                    const resultHeaders=new Headers();for(const [key,value]of Object.entries(response.headers))for(const item of Array.isArray(value)?value:[value])if(item!==undefined)resultHeaders.append(key,item);
                    resolve(new Response([204,205,304].includes(response.statusCode)?null:Buffer.concat(chunks),{status:response.statusCode,headers:resultHeaders}));
                }catch(error){reject(error);}
            });
        });
        const timer=setTimeout(()=>deadline.abort(new Error('Сервер не завершил импорт вовремя. Повторите тот же запрос поставки.')),TOOL_IMPORT_CLIENT_TIMEOUT_MS);timer.unref();
        request.once('error',reject);request.once('close',()=>clearTimeout(timer));request.end(body);
    });
}
