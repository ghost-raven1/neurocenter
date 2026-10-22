/** A regression before a SQL control point must fail the CLI instead of waiting for an unreachable callback. */
export async function waitForCancellationBarrier(entered,operation,label,timeoutMs=8000){
    let timer;
    try{
        await Promise.race([entered.promise,operation.then(outcome=>{
            if(!outcome.ok)throw outcome.error;
            throw Error('Operation completed without entering '+label);
        }),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out waiting for '+label)),timeoutMs);})]);
    }finally{clearTimeout(timer);}
}
