import {Pool} from 'pg';

/** Faults only an explicit random fixture DB, keeping a real open transaction behind a lost ACK. */
export function quotaFaultPool(url:string,options:{fail?:(sql:string)=>boolean;rollbackLost?:boolean;beginLost?:boolean;commitLost?:boolean;stage?:boolean}={}){
    const target=new URL(url);
    if(target.hostname!=='127.0.0.1'||target.port==='5432'||!/^\/nc_token_quota_[a-f0-9]+$/.test(target.pathname))throw Error('An own quota fixture database is required.');
    const pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:1000,lock_timeout:500,statement_timeout:2000,query_timeout:2500});
    const original=new Error('controlled original transaction ACK failure'),releases:boolean[]=[],pids:number[]=[];
    const stage=async(query:(sql:string,values?:unknown[])=>Promise<unknown>)=>{if(options.stage)await query("INSERT INTO quota_tx_probe VALUES('staged')");};
    const wrapped={query:pool.query.bind(pool),connect:async()=>{
        const client=await pool.connect(),query=(sql:string,values?:unknown[])=>client.query(sql,values);
        return {query:async(sql:string,values?:unknown[])=>{
            if(sql.startsWith('BEGIN')){
                const result=await query(sql,values);pids.push((await query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
                if(options.beginLost){await stage(query);throw original;}return result;
            }
            if(sql==='ROLLBACK'&&options.rollbackLost)throw Error('controlled lost ROLLBACK ACK');
            if(sql==='COMMIT'&&options.commitLost){await query(sql,values);throw original;}
            if(options.fail?.(sql)){await stage(query);throw original;}
            return query(sql,values);
        },release:(destroy=false)=>{releases.push(destroy);client.release(destroy);}};
    }} as unknown as Pool;
    return {pool,wrapped,original,releases,pids,close:()=>pool.end()};
}
