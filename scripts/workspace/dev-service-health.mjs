import http from 'node:http';
import {devListenerOrigin} from './dev-listener-origin.mjs';

/** CLI and MCP share a fixed catalogue. Mutating readiness endpoints are deliberately skipped. */
export const devServices=[
    {name:'bridge',label:'Вход и сессии',dir:'services/oauth2-bridge',port:22222,path:'/health',readinessPath:'/ready'},
    {name:'catalog',label:'Каталог',dir:'services/catalog-service',port:4100,path:'/health',readinessPath:'/ready'},
    {name:'flags',label:'Флаги функций',dir:'services/feature-flags-service',port:4400,path:'/health',readinessPath:'/ready'},
    {name:'skills',label:'Скиллы',dir:'services/skills-service',port:4200,path:'/health',readinessSkip:'side-effectful-endpoint'},
    {name:'rag',label:'Базы знаний',dir:'services/rag-sync-service',port:4300,path:'/health',readinessPath:'/ready'},
    {name:'gateway',label:'API',dir:'services/api-gateway',port:4000,path:'/health',readinessSkip:'side-effectful-endpoint'},
    {name:'frontend',label:'Веб-интерфейс',dir:'frontend',port:5173,path:'/node_modules/antd/dist/antd.less?direct'},
];
export const probeStates=['http-ok','http-error','redirect-blocked','body-limit','timeout','cancelled','unreachable','response-error','skipped'];
export const probeReasons=['disabled','not-applicable','side-effectful-endpoint','not-configured'];
export const ownershipStates=['owned','foreign','unknown','disabled'];
export const ownershipReasons=['matched-listener','different-checkout','inspection-unavailable','no-listener','ambiguous-listener','disabled'];

/** Reject misspelled local feature settings instead of silently enabling probes. */
export function serviceDetailsFlag(environment=process.env){
    const value=environment.NEUROCENTER_DEV_MCP_SERVICE_DETAILS??'1';
    if(!['0','1'].includes(value))throw Error('NEUROCENTER_DEV_MCP_SERVICE_DETAILS must be 0 or 1.');
    return value==='1';
}

const skipped=reason=>({path:null,state:'skipped',statusCode:null,ok:null,partialProbe:false,bodyBytes:0,durationMs:0,reason});

/** GET loopback directly with bounded time/body and no proxy, redirects, or returned content. */
export function probeLocalEndpoint(service,{signal,deadline=Infinity,frontend=false,headers,timeoutMs=1500}={}){
    return new Promise(resolve=>{
        const started=Date.now(),agent=new http.Agent({keepAlive:false,proxyEnv:{}});
        let done=false,bytes=0,response,request;
        const chunks=[];
        const finish=(state,statusCode=null,ok=null,partialProbe=frontend)=>{
            if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
            response?.destroy();request?.destroy();agent.destroy();
            resolve({path:service.path,state,statusCode,ok,partialProbe,bodyBytes:Math.min(bytes,32768),durationMs:Date.now()-started,reason:null});
        };
        const cancel=()=>finish('cancelled');
        const timer=setTimeout(()=>finish('timeout'),Math.max(1,Math.min(timeoutMs,deadline-Date.now())));
        request=http.request({hostname:'127.0.0.1',port:service.port,path:service.path,method:'GET',agent,headers:{accept:'application/json',...headers}},res=>{
            response=res;
            const successful=res.statusCode>=200&&res.statusCode<300,state=successful?'http-ok':'http-error';
            if(res.statusCode>=300&&res.statusCode<400){finish('redirect-blocked',res.statusCode,false);return;}
            const css=(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='text/css';
            if(frontend&&(!successful||!css)){finish(state,res.statusCode,false);return;}
            res.on('data',chunk=>{
                const remaining=32768-bytes,part=chunk.subarray(0,remaining);bytes+=part.length;
                if(frontend&&part.toString('utf8').trim()){finish(state,res.statusCode,true);return;}
                chunks.push(part);
                if(chunk.length>remaining||bytes===32768)finish('body-limit',res.statusCode,null,true);
            });
            res.once('end',()=>{
                let ok=false;
                if(successful&&!frontend)try{ok=JSON.parse(Buffer.concat(chunks).toString('utf8'))?.ok===true;}catch{}
                finish(state,res.statusCode,ok);
            });
            res.once('error',()=>finish('response-error',res.statusCode));
        });
        request.once('error',()=>finish('unreachable'));
        signal?.addEventListener('abort',cancel,{once:true});
        if(signal?.aborted)cancel();else request.end();
    });
}

/** Keep process liveness, dependency readiness, compilation and listener origin independent. */
export function devServiceHealth(definitions=devServices,{root,detailsEnabled=true,deadline=Infinity,inspectOwnership=devListenerOrigin}={}){
    if(typeof detailsEnabled!=='boolean')throw Error('detailsEnabled must be boolean.');
    return async signal=>Promise.all(definitions.map(async input=>{
        const service={...devServices.find(item=>item.name===input.name),...input};
        const frontend=service.name==='frontend',started=Date.now();
        const inspectionDeadline=Math.min(deadline,started+3000);
        const base=probeLocalEndpoint(service,{signal,deadline,frontend,timeoutMs:frontend?2500:1500});
        const readiness=!detailsEnabled?Promise.resolve(skipped('disabled')):frontend?Promise.resolve(skipped('not-applicable'))
            :service.readinessSkip?Promise.resolve(skipped(service.readinessSkip)):service.readinessPath
                ?probeLocalEndpoint({...service,path:service.readinessPath},{signal,deadline,timeoutMs:2500})
                :Promise.resolve(skipped('not-configured'));
        const [observed,dependency]=await Promise.all([base,readiness]);
        const origin=!detailsEnabled?{state:'disabled',reason:'disabled',pids:[]}
            :!root?{state:'unknown',reason:'inspection-unavailable',pids:[]}:await inspectOwnership(root,service,signal,{deadline:inspectionDeadline});
        const ready=frontend?observed.ok:dependency.state==='skipped'?null:dependency.ok===true;
        return {service:service.name,port:service.port,state:observed.state,statusCode:observed.statusCode,ready,
            partialProbe:observed.partialProbe,bodyBytes:observed.bodyBytes,durationMs:Date.now()-started,
            liveness:frontend?skipped('not-applicable'):observed,readiness:dependency,
            compilation:frontend?observed:skipped('not-applicable'),ownership:origin};
    }));
}
