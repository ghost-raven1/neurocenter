import {GatewayTimeoutException,HttpException} from '@nestjs/common';
import type {Request,Response} from 'express';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {createToolSupply} from './supply-export';

const publicErrors:Record<number,string>={400:'Некорректный запрос поставки.',401:'Войдите в Нейроцентр заново.',403:'Право выгрузки поставки отозвано.',404:'Поставка этой сборки не найдена.',409:'Точные файлы поставки недоступны или изменились. Восстановите проверенную поставку.',413:'Поставка превышает предел выгрузки 4 ГиБ.',503:'Не удалось подготовить поставку. Повторите позже.',504:'Подготовка или передача поставки превысила 5 минут.',507:'Недостаточно места для подготовки поставки.'};
export function supplyFailure(res:Response,error:unknown):void{
    if(res.destroyed)return;if(res.headersSent){res.destroy();return;}
    const candidate=error instanceof HttpException?error.getStatus():(error as {statusCode?:number})?.statusCode;
    const status=candidate&&publicErrors[candidate]?candidate:503;
    res.setHeader('Cache-Control','no-store');res.status(status).json({message:publicErrors[status]});
}

/** Export preparation and transfer share one cancellation/deadline and live RBAC fence. */
export async function sendToolSupply(req:Request,res:Response,authorize:()=>Promise<void>,prepare:(signal:AbortSignal)=>ReturnType<typeof createToolSupply>):Promise<void>{
    const abort=new AbortController(),disconnected=()=>{if(!res.writableEnded)abort.abort();};
    let exported:Awaited<ReturnType<typeof createToolSupply>>|undefined,checking=false;
    const timeout=setTimeout(()=>abort.abort(new GatewayTimeoutException()),5*60*1000);
    const permissions=setInterval(()=>{if(checking||abort.signal.aborted)return;checking=true;void authorize().catch(error=>abort.abort(error)).finally(()=>{checking=false;});},1000);
    req.on('aborted',disconnected);res.on('close',disconnected);
    try{
        if(req.aborted||res.destroyed)abort.abort();abort.signal.throwIfAborted();
        await authorize();abort.signal.throwIfAborted();exported=await prepare(abort.signal);
        await authorize();abort.signal.throwIfAborted();
        res.setHeader('Content-Type','application/gzip');res.setHeader('Content-Disposition',`attachment; filename="${exported.filename}"`);
        res.setHeader('Content-Length',String(exported.bytes));res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
        let received=0;const expected=exported.bytes;
        await pipeline(exported.stream,new Transform({transform(chunk:Buffer,_encoding,done){received+=chunk.length;done(received>expected?new Error('Supply length changed'):null,chunk);},flush(done){done(received!==expected?new Error('Supply length changed'):null);}}),res,{signal:abort.signal});
    }catch(error){if(!req.aborted)supplyFailure(res,abort.signal.aborted?abort.signal.reason:error);}
    finally{clearTimeout(timeout);clearInterval(permissions);req.off('aborted',disconnected);res.off('close',disconnected);await exported?.cleanup();}
}
