import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {hub,readState,type Credentials} from '../../bridge/state.js';
import {assertHostedInstallation,requestProfile,type HostedProfile,type HostedRequestProfile} from './profile.js';
const budget=1024*1024;
export const hostedInstallationIdentity=(profile:HostedRequestProfile)=>({kind:profile.pkg.plugin.kind,id:profile.pkg.plugin.id,version:profile.pkg.plugin.version,manifest:profile.pkg.manifest.sha256});
export interface HostedRelay {profile:HostedProfile;close:()=>Promise<void>}
export function validateVectors(value:unknown,profile:HostedRequestProfile,count:number):void {
    const result=value as {model?:unknown;data?:Array<{index?:unknown;embedding?:unknown}>}|null;
    if(result?.model!==profile.selection.profile.model||!Array.isArray(result.data)||result.data.length!==count
        ||result.data.some((row,index)=>row.index!==index||!Array.isArray(row.embedding)||row.embedding.length!==profile.selection.profile.dimension
            ||!row.embedding.every(n=>typeof n==='number'&&Number.isFinite(Math.fround(n)))||!row.embedding.some(n=>n!==0)))throw new Error('Серверная модель вернула неподтверждённые векторы.');
}
/** DeviceBearer читается заново; в HTTP-ответы дочернего процесса он не попадает. */
export async function inferHosted(source:HostedRequestProfile,input:string|string[],signal:AbortSignal):Promise<unknown> {
    const profile=structuredClone(source);
    await assertHostedInstallation(profile);
    const credentials=await readState<Credentials>('credentials');if(!credentials?.token)throw new Error('Компьютер не подключён.');
    const response=await fetch(hub()+'/api/device-channel/embedding',{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+credentials.token},
        body:JSON.stringify({installation:hostedInstallationIdentity(profile),projectId:profile.projectId,bindingId:profile.bindingId,instanceId:profile.instanceId,expectedRevision:profile.selection.revision,expectedModelPin:profile.selection.modelPin,model:profile.selection.profile.model,input}),signal});
    const length=Number(response.headers.get('content-length'));if(length>64*65535*24){await response.body?.cancel();throw new Error('Ответ модели превышает лимит.');}
    if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Серверная модель недоступна или подключение изменилось. Проверьте модель и права на проект.'),{status:response.status});}
    // Векторы ограничены числом входов и размерностью; тело читается с отдельным лимитом.
    const limit=(Array.isArray(input)?input.length:1)*profile.selection.profile.dimension*32+65536;const reader=response.body?.getReader();if(!reader)throw new Error('Пустой ответ модели.');
    const chunks:Uint8Array[]=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('Ответ модели превышает лимит.');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));validateVectors(result,profile,Array.isArray(input)?input.length:1);return result;
}
/** Идентичность запроса зависит от значений профиля, а не порядка ключей после JSONB. */
function generation(profile:HostedRequestProfile):string{
    const selection=profile.selection,index=selection.profile;
    return JSON.stringify([profile.server,profile.root,profile.projectId,profile.bindingId,profile.instanceId,profile.pkg.manifest?.sha256,
        selection.revision,selection.modelPin,index.provider,index.model,index.dimension,profile.relay.port,profile.relay.key]);
}
export async function createHostedRelay(profile:HostedProfile):Promise<HostedRelay> {
    const relay:HostedRelay={profile:structuredClone(profile),close:async()=>{for(const controller of active)controller.abort();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}};
    const active=new Set<AbortController>();let busy=false;
    const server=http.createServer(async(req,res)=>{
        const connection=structuredClone(relay.profile);
        const send=(status:number,message:string)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{message}}));}};
        if(req.method!=='POST'||req.url!=='/v1/embeddings'){send(404,'Маршрут недоступен.');return;}
        if(req.headers.origin||req.headers.host!==`127.0.0.1:${connection.relay.port}`){send(403,'Доступ из браузера запрещён.');return;}
        const token=Buffer.from(String(req.headers.authorization||''));const grant=connection.grants.find(item=>{const expected=Buffer.from('Bearer '+item.key);return token.length===expected.length&&timingSafeEqual(token,expected);});
        if(!grant){send(401,'Требуется локальное подключение RAG.');return;}
        const profile=requestProfile(connection,grant),started=generation(profile);
        const assertCurrent=()=>{const current=relay.profile.grants.find(item=>item.key===grant.key);if(!current||generation(requestProfile(relay.profile,current))!==started)throw Object.assign(new Error('Подключение изменилось.'),{status:409});};
        if(busy){send(429,'Дождитесь завершения предыдущего запроса.');return;}
        busy=true;const controller=new AbortController();active.add(controller);const disconnected=()=>controller.abort();res.on('close',disconnected);
        try{
            const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>budget)throw new Error('Слишком большой запрос.');chunks.push(chunk);}
            const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {model?:unknown;input?:unknown;input_type?:unknown};const inputs=Array.isArray(body.input)?body.input:[body.input];
            if(body.model!==profile.selection.profile.model||!inputs.length||inputs.length>64||inputs.some(input=>typeof input!=='string'||!input.trim())||Object.keys(body).some(key=>!['model','input','input_type'].includes(key))) {send(400,'Проверьте модель и входные данные.');return;}
            assertCurrent();const result=await inferHosted(profile,body.input as string|string[],AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]));
            await assertHostedInstallation(profile);assertCurrent();if(!res.destroyed){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result));}
        }catch(error){send((error as {status?:number}).status===409?409:503,'Модель недоступна. Проверьте подключение и настройку проекта.');}
        finally{res.off('close',disconnected);active.delete(controller);busy=false;}
    });
    server.requestTimeout=125000;server.headersTimeout=10000;server.maxConnections=4;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(profile.relay.port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    profile.relay.port=(server.address() as {port:number}).port;relay.profile.relay.port=profile.relay.port;
    return relay;
}
