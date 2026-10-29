import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedBuild} from './isolated-build.mjs';
import {devProcessIdentity} from './dev-processes.mjs';
import {groupAlive} from './dev-watch-owned.mjs';
import {watchSnapshot,changedWatchInputs,affectedPackages,watchPackageSelection} from './dev-watch-plan.mjs';
import {createWatchQueue} from './dev-watch-queue.mjs';
import {initialWatchGeneration,publishWatchGeneration,cleanupWatchBuild,writeWatchFile,entryGeneration} from './dev-watch-files.mjs';
import {WatchRuntime} from './dev-watch-runtime.mjs';
let initialized=false,queue,runtime,stopping=false,state={},writes=Promise.resolve();const lifecycle=new AbortController();
const send=message=>{if(process.connected)process.send(message);};
const stop=async()=>{if(stopping)return;stopping=true;lifecycle.abort();try{await queue?.close();await runtime?.close();await writes;process.exitCode=0;}catch{send({kind:'failed',code:'WATCH_CLEANUP_FAILED'});process.exitCode=1;}finally{process.disconnect?.();}};
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());process.once('disconnect',()=>void stop());
process.on('message',message=>{if(initialized||message?.kind!=='start')return;initialized=true;void run(message.config).catch(async()=>{send({kind:'failed',code:'WATCH_START_FAILED'});await stop();});});
/** A caller-supplied stat baseline avoids duplicate builds; artifact/source byte verification stays with the caller. */
function preparedSnapshot(prepared){
    if(!prepared||!Object.hasOwn(prepared,'sourceSnapshot'))return;
    const entries=prepared.sourceSnapshot;if(!Array.isArray(entries)||entries.length>20000)throw Error('WATCH_UNSAFE_SOURCE_SNAPSHOT');
    const result=new Map();for(const entry of entries){
        if(!Array.isArray(entry)||entry.length!==2)throw Error('WATCH_UNSAFE_SOURCE_SNAPSHOT');
        const [file,stat]=entry;
        if(typeof file!=='string'||!file||file.length>8192||file.includes('\0')||file.includes('\\')||path.posix.isAbsolute(file)||path.posix.normalize(file)!==file||file==='..'||file.startsWith('../')
            ||typeof stat!=='string'||!/^\d+:\d+:-?\d+:-?\d+$/.test(stat)||result.has(file))throw Error('WATCH_UNSAFE_SOURCE_SNAPSHOT');
        result.set(file,stat);
    }return result;
}
async function run(config){
    const update=patch=>{state={...state,...patch,updatedAt:new Date().toISOString()};const snapshot={...state};writes=writes.then(()=>writeWatchFile(config.root,'status.json',snapshot));void writes.catch(()=>{void stop();});};
    state={schemaVersion:1,pid:config.watcherRecord.pid,identity:config.watcherRecord.identity,startedAt:new Date().toISOString(),phase:'starting'};
    const prepared=config.initialGeneration;
    if(prepared&&(!entryGeneration(config.root,path.join(prepared.repository,'services/catalog-service/dist/main.js'))||path.dirname(prepared.repository)!==prepared.folder))throw Error('WATCH_UNSAFE_GENERATION');
    const sourceBaseline=preparedSnapshot(prepared);
    const options={nativeEnabled:config.nativeEnabled!==false};
    runtime=new WatchRuntime(config,send);const baseline=prepared??await initialWatchGeneration(config.root,lifecycle.signal,options);lifecycle.signal.throwIfAborted();await runtime.start(baseline,lifecycle.signal);
    let previous=await watchSnapshot(config.root,options);
    queue=createWatchQueue({onState:update,build:async(selection,signal)=>{const groups=[];try{return await isolatedBuild(config.root,selection,{signal,buildOwnerFile:path.join(config.root,'scripts/workspace/dev-watch-child.mjs'),onBuildProcess:pid=>{const record={pid,identity:devProcessIdentity(pid)};groups.push(record);send({kind:'group',record});}});}finally{for(const record of groups)if(!groupAlive(record.pid))send({kind:'release',pid:record.pid});}},
        publish:async(result,selection,signal)=>{if(result.inputs?.bytes>64*1024**2)throw Object.assign(Error(),{code:'WATCH_RUNTIME_INPUT_LIMIT'});const generation=await publishWatchGeneration(config.root,result);try{await runtime.publish(generation,selection,signal);}finally{await runtime.prune();}},
        cleanup:result=>cleanupWatchBuild(config.root,result)});
    update({phase:'watching'});await writes;send({kind:'ready'});
    // Ordinary starts rebuild once; a prepared baseline retains only edits made after its source verification.
    const initialSelection=sourceBaseline?affectedPackages(changedWatchInputs(sourceBaseline,previous),options):watchPackageSelection(options);
    if(initialSelection.length)queue.enqueue(initialSelection);
    while(!stopping){await delay(750,undefined,{signal:lifecycle.signal}).catch(()=>{});if(stopping)break;try{const next=await watchSnapshot(config.root,options),changed=changedWatchInputs(previous,next);previous=next;if(changed.length)queue.enqueue(affectedPackages(changed,options));}catch{update({phase:'watch-input-error',lastBuild:{ok:false,code:'WATCH_INPUT_UNAVAILABLE'}});}}
}
