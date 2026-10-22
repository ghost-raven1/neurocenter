import {setTimeout as delay} from 'node:timers/promises';

/** A failed native-fixture admission never strands the borrowed PostgreSQL barrier session. */
export async function executionStartBarrier(pool){
    const key=81726354,client=await pool.connect();let released=false,closed=false;
    const release=async(discard=false)=>{
        if(released)return;released=true;const failures=[];
        try{await client.query('SELECT pg_advisory_unlock($1)',[key]);}catch(error){failures.push(error);}
        try{client.release(discard||failures.length>0);}catch(error){failures.push(error);}
        if(failures.length)throw new AggregateError(failures,'Execution-start barrier lease cleanup failed.',{cause:failures[0]});
    };
    const close=async(discard=false)=>{
        if(closed)return;closed=true;const failures=[];
        try{await release(discard);}catch(error){failures.push(error);}
        for(const sql of ['DROP TRIGGER IF EXISTS fixture_execution_start_barrier ON tool_build_jobs','DROP FUNCTION IF EXISTS fixture_execution_start_barrier()'])
            try{await pool.query(sql);}catch(error){failures.push(error);}
        if(failures.length)throw new AggregateError(failures,'Execution-start barrier cleanup failed.',{cause:failures[0]});
    };
    try{
        await client.query('SELECT pg_advisory_lock($1)',[key]);
        const pid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        await pool.query(`CREATE FUNCTION fixture_execution_start_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.execution_started AND NOT OLD.execution_started THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`);
        await pool.query('CREATE TRIGGER fixture_execution_start_barrier BEFORE UPDATE OF execution_started ON tool_build_jobs FOR EACH ROW EXECUTE FUNCTION fixture_execution_start_barrier()');
        return {pid,release:()=>release(),close:()=>close()};
    }catch(primary){
        try{await close(true);}catch(cleanup){throw new AggregateError([primary,cleanup],'Execution-start barrier admission and cleanup failed.',{cause:primary});}
        throw primary;
    }
}

/** A live owned PID is a failed receipt, even after the immediate parent has been hard-killed. */
export async function recordOwnedProcessReap(receipt,pids,alive,{timeoutMs=10000,intervalMs=20}={}){
    const deadline=Date.now()+timeoutMs;
    let pending=pids.filter(alive);
    while(pending.length&&Date.now()<deadline){await delay(Math.min(intervalMs,Math.max(0,deadline-Date.now())));pending=pids.filter(alive);}
    receipt.allOwnedProcessesExited=pending.length===0;receipt.remainingOwnedPids=pending;
    if(pending.length){receipt.ok=false;receipt.failures.push({name:'owned process cleanup',message:'Owned processes did not exit before cleanup deadline',pids:pending});}
    return receipt.allOwnedProcessesExited;
}
