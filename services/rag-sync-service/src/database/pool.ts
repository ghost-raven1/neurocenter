import {Logger} from '@nestjs/common';
import {Pool,type ClientBase,type PoolConfig} from 'pg';

/** Логирует разрыв; запросы, отмена и освобождение клиента остаются у владельца. */
export function observeClientErrors(client:ClientBase,scope:string):void{
    const logger=new Logger('PostgreSQL:'+scope);
    client.on('error',error=>{logger.warn('Соединение PostgreSQL прервано. Код: '+((error as {code?:string}).code||'unknown'));});
}

/** Постоянный обработчик защищает и выданные клиенту соединения, пока pg снимает свой idle-listener. */
export function createPool(config:PoolConfig,scope:string):Pool{
    return new Pool({connectionTimeoutMillis:5000,...config,application_name:'neurocenter:'+scope})
        .on('connect',client=>observeClientErrors(client,scope))
        // Разрыв уже записан клиентом; pg сам удаляет повреждённое idle-соединение.
        .on('error',()=>undefined);
}
