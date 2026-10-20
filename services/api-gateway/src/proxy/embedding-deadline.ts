/** Отмена завершает ожидание, даже если проверка доступа ещё не приняла signal. */
export function awaitEmbedding<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
    return new Promise((resolve,reject)=>{
        const cleanup=()=>signal.removeEventListener('abort',cancel);
        const cancel=()=>{cleanup();reject(signal.reason);};
        signal.addEventListener('abort',cancel,{once:true});
        work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
        if(signal.aborted)cancel();
    });
}
