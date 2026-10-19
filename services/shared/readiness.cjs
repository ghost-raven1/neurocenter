'use strict';
/** Готовность зависимостей ограничена по времени; ответ не раскрывает URL и секреты. */
async function checkReadiness(checks) {
    const entries=await Promise.all(Object.entries(checks).map(async([name,check])=>{
        let timer;
        try{await Promise.race([Promise.resolve().then(check),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),2500);})]);return [name,'ready'];}
        catch{return [name,'unavailable'];}finally{clearTimeout(timer);}
    }));
    return {ok:entries.every(([,status])=>status==='ready'),checks:Object.fromEntries(entries)};
}
async function httpReady(base) {
    const response=await fetch(base.replace(/\/$/,'')+'/ready',{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok){throw new Error('unavailable');}
}
module.exports={checkReadiness,httpReady};
