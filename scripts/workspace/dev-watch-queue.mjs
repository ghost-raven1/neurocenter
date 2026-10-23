/** One bounded serial build, with edits during compilation retained for the next current-source attempt. */
export function createWatchQueue({build,publish,onState=()=>{},debounceMs=600,cleanup=async()=>{}}){
    const pending=new Map();let timer,running=false,closed=false,active,done=Promise.resolve(),generation=0;
    const state=(phase,extra={})=>onState({phase,pending:[...pending.keys()],...extra});
    const schedule=()=>{clearTimeout(timer);if(!closed&&!running&&pending.size){timer=setTimeout(()=>void flush(),debounceMs);timer.unref?.();}};
    const enqueue=selection=>{if(closed)return;for(const item of selection)pending.set(item[0],item);generation++;state(running?'building':'waiting');schedule();};
    const flush=async()=>{
        if(closed||running||!pending.size)return;running=true;const selection=[...pending.values()],observed=generation;pending.clear();active=new AbortController();state('building',{selected:selection.map(([id])=>id)});
        done=(async()=>{let result;try{
            result=await build(selection,active.signal);if(closed||active.signal.aborted)return;
            if(result.ok&&observed===generation){await publish(result,selection,active.signal);state('watching',{lastBuild:{ok:true,selected:selection.map(([id])=>id)}});}
            else if(result.ok||String(result.primaryFailure?.code).startsWith('SOURCE_CHANGED')){for(const item of selection)pending.set(item[0],item);state('waiting',{lastBuild:{ok:false,code:'SOURCE_CHANGED'}});}
            else state('build-failed',{lastBuild:{ok:false,code:result.primaryFailure?.code||'BUILD_FAILED',selected:selection.map(([id])=>id)}});
        }catch(error){if(!closed)state('build-failed',{lastBuild:{ok:false,code:/^[A-Z_]{1,80}$/.test(error?.code||'')?error.code:'WATCH_BUILD_FAILED'}});}
        finally{if(result)await cleanup(result).catch(()=>{});running=false;active=undefined;schedule();}})();await done;
    };
    return {enqueue,flush,async close(){closed=true;clearTimeout(timer);active?.abort();await done;state('stopped');},get pending(){return [...pending.keys()];}};
}
