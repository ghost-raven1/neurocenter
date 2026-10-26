import {Agent,request,type AgentOptions} from 'node:https';
import {Readable} from 'node:stream';

/** Relax certificate checks for this dependency request without changing the Catalog runtime or redirect policy. */
export function fetchNpmMetadata(url:string,{signal}:{signal:AbortSignal;redirect:'error'}):Promise<Response>{
    const options:AgentOptions&{proxyEnv?:NodeJS.ProcessEnv}={rejectUnauthorized:false,keepAlive:false,
        ...(process.env.NODE_USE_ENV_PROXY==='1'?{proxyEnv:process.env}:{})};
    const agent=new Agent(options);
    return new Promise((resolve,reject)=>{
        const pending=request(url,{agent,signal},response=>{
            response.once('close',()=>agent.destroy());
            if(response.statusCode&&response.statusCode>=300&&response.statusCode<400){
                response.resume();reject(new Error('npm registry redirect is not allowed'));return;
            }
            const empty=response.statusCode===204||response.statusCode===205;
            if(empty)response.resume();
            try{resolve(new Response(empty?null:Readable.toWeb(response) as ReadableStream<Uint8Array>,{status:response.statusCode??502}));}
            catch(error){response.destroy();reject(error);}
        });
        pending.once('error',error=>{agent.destroy();reject(error);});
        pending.end();
    });
}
