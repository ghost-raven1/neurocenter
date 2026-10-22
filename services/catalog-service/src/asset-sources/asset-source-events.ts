/** A committed startup seed invalidates the open catalog; delivery failure never rolls back its data. */
export async function notifyAssetSourceChange(signal?:AbortSignal):Promise<void>{
    const token=process.env.NEUROCENTER_INTERNAL_TOKEN;
    if(!token||signal?.aborted)return;
    await fetch((process.env.API_GATEWAY_URL||'http://localhost:4000').replace(/\/$/,'')+'/internal/events',{
        method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':token},body:JSON.stringify({sections:['catalog']}),
        signal:AbortSignal.any([AbortSignal.timeout(1500),...(signal?[signal]:[])]),
    }).then(response=>response.body?.cancel()).catch(()=>undefined);
}
