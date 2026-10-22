const redirects=new Set([301,302,303,307,308]);
const unavailable=cause=>Object.assign(new Error('Источник ассетов временно недоступен; проверенный кэш сохранён.',{cause}),{code:'ASSET_RETRIEVAL_UNAVAILABLE'});

/** Classify only retrieval failures; the immutable contract retains SHA, size and redirect validation. */
export function assetRetrievalFetch(request=globalThis.fetch){
    return async(input,options)=>{
        const failure=error=>options?.signal?.aborted&&options.signal.reason?.name!=='TimeoutError'?options.signal.reason
            :error?.code==='ECANCELED'?error:unavailable(error);
        let response;
        try{response=await request(input,options);}catch(error){throw failure(error);}
        if(!redirects.has(response.status)&&(!response.ok||!response.body)){
            await response.body?.cancel().catch(()=>undefined);throw failure(Error('Asset source did not return its declared file.'));
        }
        if(!response.body)return response;
        const reader=response.body.getReader();let released=false;
        const release=()=>{if(!released){reader.releaseLock();released=true;}};
        const body=new ReadableStream({
            async pull(controller){
                try{const {done,value}=await reader.read();if(done){release();controller.close();}else controller.enqueue(value);}
                catch(error){release();controller.error(failure(error));}
            },
            async cancel(reason){try{await reader.cancel(reason);}finally{release();}},
        });
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    };
}
