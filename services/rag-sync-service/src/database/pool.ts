import {Logger} from '@nestjs/common';
import {Pool,type PoolConfig} from 'pg';

/** pg удаляет повреждённый idle-клиент, а сервис продолжает обслуживать другие проекты. */
export function createPool(config:PoolConfig,scope:string):Pool{
    const logger=new Logger('PostgreSQL:'+scope);
    return new Pool({connectionTimeoutMillis:5000,...config,application_name:'neurocenter:'+scope}).on('error',error=>{logger.warn('Соединение PostgreSQL прервано; следующий запрос создаст новое. Код: '+((error as {code?:string}).code||'unknown'));});
}
