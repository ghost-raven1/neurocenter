import type {Pool} from 'pg';
import type {Job} from './device-job.model';
import {notifyDeviceOperations, recordDeviceOperation} from './device-operations';
import {publishMethodChatResult} from '../agent-method-workflows/chat-origin';

/** Очередь и её видимый статус меняются вместе: отказ журнала не оставляет вечную активную операцию. */
export async function transitionDeviceJobs(pool:Pool,sql:string,values:unknown[],projection:{state:string;message:string;percent?:number}) {
    const client=await pool.connect();
    let saved;
    try {
        await client.query('BEGIN');
        saved=await client.query<Job>(sql,values);
        for(const job of saved.rows) {
            if(['failed','cancelled'].includes(job.state))await publishMethodChatResult(client,job);
            await recordDeviceOperation(client,job,projection.state,projection.percent??job.percent??0,projection.message);
        }
        await client.query('COMMIT');
    } catch(error) {
        await client.query('ROLLBACK').catch(()=>undefined);
        throw error;
    } finally {client.release();}
    if(saved.rows.length) {await notifyDeviceOperations();}
    return saved;
}
