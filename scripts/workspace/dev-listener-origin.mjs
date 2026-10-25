import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import path from 'node:path';

const inspectionEnvironment={PATH:process.env.PATH||'',LC_ALL:'C.UTF-8',TZ:'UTC'};
const lsof=process.platform==='darwin'?'/usr/sbin/lsof':'lsof';
const unknown=reason=>({state:'unknown',reason,pids:[]});
const processModule=new URL('./dev-processes.mjs',import.meta.url).href;
const identityWorker=`import {devProcessIdentity,ownsDevProcess} from ${JSON.stringify(processModule)};
    const pid=Number(process.argv[1]),root=process.argv[2],service=JSON.parse(process.argv[3]);
    const identity=devProcessIdentity(pid),owned=identity?ownsDevProcess({pid},root,service):false;
    console.log(JSON.stringify({known:!!identity,stable:!!identity&&identity===devProcessIdentity(pid),owned}));`;

function listenerPids(raw,port){
    let pid;const listeners=new Set();
    for(const line of raw.split('\n')){
        if(/^p[1-9]\d*$/.test(line))pid=Number(line.slice(1));
        else if(Number.isSafeInteger(pid)&&line.startsWith('n')&&new RegExp(`^(?:127\\.0\\.0\\.1|\\*|\\[::\\]):${port}$`).test(line.slice(1)))listeners.add(pid);
    }
    return [...listeners];
}

/** Bounded OS metadata stays private; never return command lines or directories. */
function inspect(binary,args,signal,timeoutMs=650){
    return new Promise(resolve=>{
        if(signal?.aborted){resolve(null);return;}
        let child,output='',errors='',done=false,cancelled=false;
        const finish=value=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve(value);};
        const cancel=()=>{
            cancelled=true;
            if(!child?.pid){finish(null);return;}
            try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}
            catch(error){if(error.code!=='ESRCH')finish(null);}
        };
        const timer=setTimeout(cancel,Math.max(1,timeoutMs));
        try{
            child=spawn(binary,args,{env:inspectionEnvironment,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
            child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>32768)cancel();});
            child.stderr.on('data',chunk=>{errors+=chunk.toString('utf8');if(Buffer.byteLength(errors)>4096)cancel();});
            child.once('error',()=>finish(null));
            child.once('close',code=>finish(!cancelled&&(code===0||code===1&&!errors)?output:null));
            signal?.addEventListener('abort',cancel,{once:true});
            if(signal?.aborted)cancel();
        }catch{finish(null);}
    });
}

/** Check the actual listener, then verify its identity and checkout with existing ownership rules. */
export async function devListenerOrigin(root,service,signal,{deadline=Date.now()+1800}={}){
    if(!Number.isInteger(service.port)||service.port<1||service.port>65535)return unknown('inspection-unavailable');
    const bounded=(binary,args)=>Date.now()>=deadline?Promise.resolve(null):inspect(binary,args,signal,Math.min(650,deadline-Date.now()));
    const raw=await bounded(lsof,['-nP',`-iTCP:${service.port}`,'-sTCP:LISTEN','-Fpn']);
    if(raw===null)return unknown('inspection-unavailable');
    const pids=listenerPids(raw,service.port);
    if(!pids.length)return unknown('no-listener');
    if(pids.length!==1)return {...unknown('ambiguous-listener'),pids:pids.slice(0,8)};
    const [pid]=pids;
    // lsof makes a denied cwd inspection distinguishable from a foreign checkout.
    const cwd=await bounded(lsof,['-a','-p',String(pid),'-d','cwd','-Fn']);
    const directory=cwd?.split('\n').find(line=>line.startsWith('n'))?.slice(1);
    if(!directory)return unknown('inspection-unavailable');
    let matchingDirectory;
    try{matchingDirectory=realpathSync(directory)===realpathSync(path.join(root,service.dir));}
    catch{return unknown('inspection-unavailable');}
    // Existing synchronous process checks run in an owned worker so OS stalls cannot block HTTP cancellation.
    if(matchingDirectory){
        const serviceIdentity={name:service.name,dir:service.dir,...(service.entry?{entry:service.entry}:{})};
        const checked=await bounded(process.execPath,['--input-type=module','--eval',identityWorker,String(pid),root,JSON.stringify(serviceIdentity)]);
        let identity;
        try{identity=JSON.parse(checked);}catch{return unknown('inspection-unavailable');}
        if(signal?.aborted||!identity?.known||!identity.stable||!identity.owned)return unknown('inspection-unavailable');
    }
    const final=await bounded(lsof,['-nP',`-iTCP:${service.port}`,'-sTCP:LISTEN','-Fpn']);
    if(final===null)return unknown('inspection-unavailable');
    const active=listenerPids(final,service.port);
    if(!active.length)return unknown('no-listener');
    if(active.length!==1||active[0]!==pid)return {...unknown('ambiguous-listener'),pids:active.slice(0,8)};
    return {state:matchingDirectory?'owned':'foreign',reason:matchingDirectory?'matched-listener':'different-checkout',pids};
}
