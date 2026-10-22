/** A failed rollback/unlock must destroy the borrowed session and cannot strand pool.end(). */
export async function releaseCancellationLease(client,rollback=true){
    const failures=[];
    if(rollback)try{await client.query('ROLLBACK');}catch(error){failures.push(error);}
    try{await client.query('SELECT pg_advisory_unlock(72465395)');}catch(error){failures.push(error);}
    try{client.release(failures.length>0);}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Owned cancellation lease cleanup failed.',{cause:failures[0]});
}
