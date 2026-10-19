import http from 'node:http';
import {createRequire} from 'node:module';

const {FEATURE_FLAGS}=createRequire(import.meta.url)('../../services/shared/feature-flags.cjs');

/** Изолирует проверки очереди от рабочего сервиса флагов и проверяет собственный внутренний ключ. */
export async function startFlagsFixture(token){
    const server=http.createServer((request,response)=>{
        if(request.method!=='GET'||request.url!=='/internal/feature-flags/evaluated'){
            response.writeHead(404).end();return;
        }
        if(request.headers['x-neurocenter-internal']!==token){response.writeHead(401).end();return;}
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({flags:Object.fromEntries(FEATURE_FLAGS.map(flag=>[flag.key,true]))}));
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    return {url:'http://127.0.0.1:'+server.address().port,async close(){
        server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }};
}
