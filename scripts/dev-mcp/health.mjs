import http from 'node:http';
import {services as defaults,DiagnosticError} from './constants.mjs';

/** Only the test-side constructor can supply owned local ports; tool arguments never accept destinations. */
export function healthReader(definitions=defaults){
    if(!Array.isArray(definitions)||definitions.length>8||definitions.some(item=>!defaults.some(service=>service.name===item.name)
        ||!Number.isInteger(item.port)||item.port<1||item.port>65535||!/^\/(?!\/)[^\r\n]*$/.test(item.path)))throw new DiagnosticError('SERVICE_CONFIGURATION','Invalid fixed local health configuration.');
    return async function servicesHealth(signal){
        const results=await Promise.all(definitions.map(service=>new Promise(resolve=>{
            const started=Date.now(),agent=new http.Agent({keepAlive:false,proxyEnv:{}});
            let done=false,bytes=0,response;
            const chunks=[],frontend=service.name==='frontend';
            const finish=(state,statusCode=null,ready=null,partialProbe=false)=>{
                if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
                response?.destroy();request.destroy();agent.destroy();resolve({service:service.name,port:service.port,state,statusCode,ready,partialProbe,bodyBytes:Math.min(bytes,32768),durationMs:Date.now()-started});
            };
            const cancel=()=>finish('cancelled');
            const request=http.request({hostname:'127.0.0.1',port:service.port,path:service.path,method:'GET',agent,headers:{accept:'application/json'}},res=>{
                response=res;
                const successful=res.statusCode>=200&&res.statusCode<300,state=successful?'http-ok':'http-error';
                if(res.statusCode>=300&&res.statusCode<400){finish('redirect-blocked',res.statusCode,false);return;}
                const css=(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='text/css';
                if(frontend&&(!successful||!css)){finish(state,res.statusCode,false,true);return;}
                res.on('data',chunk=>{
                    const remaining=32768-bytes,part=chunk.subarray(0,remaining);bytes+=part.length;
                    if(frontend){if(part.toString('utf8').trim()){finish(state,res.statusCode,true,true);return;}}
                    else chunks.push(part);
                    if(chunk.length>remaining||bytes===32768)finish('body-limit',res.statusCode,null,true);
                });
                res.once('end',()=>{
                    let ready=false;
                    if(successful&&!frontend)try{ready=JSON.parse(Buffer.concat(chunks).toString('utf8'))?.ok===true;}catch{}
                    finish(state,res.statusCode,ready);
                });
                res.once('error',()=>finish('response-error',res.statusCode));
            });
            const timer=setTimeout(()=>finish('timeout'),1500);
            request.once('error',()=>finish('unreachable'));
            signal?.addEventListener('abort',cancel,{once:true});
            if(signal?.aborted)cancel();else request.end();
        })));
        return {scope:'Fixed local endpoint probes; response content is discarded. ready describes this probe; /health is liveness and does not verify database or other dependencies.',services:results};
    };
}
