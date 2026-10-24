import type {Pool,PoolClient} from 'pg';
import {configureBuildPublicationTransaction} from '../package-build/publication-deadline';

/** Only request-owned cache registration acquires bounded SQL waits; callers still await rollback. */
export async function withImportRegistryTransaction<T>(pool:Pool,signal:AbortSignal|undefined,work:(client:Pick<PoolClient,'query'>)=>Promise<T>):Promise<T>{
    if(!signal)return work(pool);
    signal.throwIfAborted();const client=await pool.connect();let tainted=false;
    try{
        signal.throwIfAborted();await client.query('BEGIN');await configureBuildPublicationTransaction(client);signal.throwIfAborted();
        const result=await work(client);signal.throwIfAborted();await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{tainted=true;}throw error;}
    finally{if(tainted)client.release(true);else client.release();}
}
