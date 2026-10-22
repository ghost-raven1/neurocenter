import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {ProviderContext,Authorize} from './context.js';
import {providerStatus,saveProvider} from './engine.js';
import {providerProof} from './receipt.js';
import {providerPage} from './page.js';
import {codexModels,beginProviderLogin,type CodexLogin} from './connector.js';
const active=new Map<string,()=>Promise<void>>();
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
    if(req.headers['content-type']!=='application/json')throw Error();let length=0;const chunks:Buffer[]=[];
    for await(const chunk of req){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>16384)throw Error();chunks.push(bytes);}
    const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;
}
/** One browser capability, same-origin CSRF and a fresh server permit before the filesystem transaction. */
export async function startProviderSession(context:ProviderContext,id:string,expiresAt:string,authorizeSave:Authorize,open:(url:string)=>Promise<boolean>,setupJobId:string):Promise<void>{
    if(active.has(id))return;const deadline=Date.parse(expiresAt);if(!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+900000)throw Error('Сессия настройки истекла.');
    await authorizeSave();await context.assertCurrent();const initial=context.descriptor.providerKind==='codex-bridge'?{revision:(await providerProof(context))?.receipt.revision??null,ready:false}:await providerStatus(context,async()=>{}),token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),nonce=randomBytes(24).toString('base64url');
    const lifecycle=new AbortController();let used=false,attempted=false,closed=false,loginStarting=false,login:CodexLogin|undefined,pendingLogin:Promise<CodexLogin>|undefined;const current=()=>{lifecycle.signal.throwIfAborted();if(closed||Date.now()>=deadline)throw Error();};
    const models=async(signal:AbortSignal)=>{try{return {...await codexModels(context,signal),loginRequired:false};}catch(error){if((error as {code?:string}).code==='CODEX_LOGIN_REQUIRED')return {models:[],defaultModel:'',loginRequired:true};throw error;}};
    const server=createServer((req,res)=>{let abandoned=false;const requestAbort=new AbortController(),signal=AbortSignal.any([lifecycle.signal,requestAbort.signal]);res.once('close',()=>{if(!res.writableEnded){abandoned=true;requestAbort.abort();}});const requestCurrent=()=>{current();signal.throwIfAborted();if(abandoned)throw Error();};const admit=async()=>{requestCurrent();await context.assertCurrent();await authorizeSave();requestCurrent();};void(async()=>{
        current();const address=server.address();if(!address||typeof address==='string')throw Error();const host='127.0.0.1:'+address.port,origin='http://'+host;
        if(req.headers.host!==host||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')){json(res,403,{});return;}
        if(req.method==='GET'&&req.url==='/'){
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});
            res.end(providerPage.replace('<style>',`<style nonce="${nonce}">`).replace('<script>',`<script nonce="${nonce}">`));return;
        }
        if(req.method!=='POST'||req.headers.origin!==origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'){json(res,403,{});return;}
        const value=await body(req);current();
        if(req.url==='/session'&&!used&&Object.keys(value).length===1&&value.token===token){used=true;await admit();const e=context.descriptor.expectations;
            const extra=context.descriptor.providerKind==='codex-bridge'?await models(signal):{};current();json(res,200,{csrf,revision:initial.revision,providerKind:context.descriptor.providerKind,baseUrl:e?.baseUrl,runtimeModel:e?.runtimeModel,credentialConfigured:initial.ready,expiresAt,...extra});return;}
        if(!used||attempted||req.headers['x-provider-csrf']!==csrf){json(res,403,{});return;}
        if(context.descriptor.providerKind==='codex-bridge'&&['/login','/models'].includes(req.url??'')&&Object.keys(value).length===0){
            if(req.url==='/models'){await admit();const result=await models(signal);requestCurrent();json(res,200,result);return;}
            if(login||loginStarting)throw Error();loginStarting=true;try{await admit();pendingLogin=beginProviderLogin(context,signal);login=await pendingLogin;try{requestCurrent();}catch(error){await login.close();throw error;}const owned=login;void owned.finished.then(async()=>{await owned.close();if(login===owned){login=undefined;pendingLogin=undefined;}},async()=>{await owned.close();if(login===owned){login=undefined;pendingLogin=undefined;}}).catch(()=>{});json(res,200,{url:owned.url});return;}finally{loginStarting=false;}
        }
        const key=context.descriptor.providerKind==='codex-bridge'?'modelId':'apiKey';
        if(req.url!=='/save'||Object.keys(value).some(k=>![key,'expectedRevision'].includes(k))||value.expectedRevision!==initial.revision){json(res,403,{});return;}
        attempted=true;const result=await saveProvider(context,value[key],initial.revision,async()=>{requestCurrent();await authorizeSave();requestCurrent();},requestCurrent,{preparationId:id,setupJobId},signal);requestCurrent();json(res,200,{ready:result.ready,state:result.state});
    })().catch(error=>{if(!res.headersSent)json(res,(error as {code?:string})?.code==='OPENCODE_PROVIDER_CONFLICT'?409:400,{message:'Настройка недоступна. Откройте форму заново.'});else res.end();});});
    server.requestTimeout=5000;server.headersTimeout=5000;server.maxHeadersCount=30;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string'){server.close();throw Error();}
    let closing:Promise<void>|undefined;const close=()=>closing??=(async()=>{closed=true;lifecycle.abort();clearTimeout(timer);server.closeAllConnections();server.close();const pending=await pendingLogin?.catch(()=>undefined);await (login??pending)?.close().catch(()=>{});active.delete(id);})();
    const timer=setTimeout(()=>{void close();},Math.max(1,deadline-Date.now()));timer.unref();server.unref();active.set(id,close);
    try{if(!await open('http://127.0.0.1:'+address.port+'/#'+token))throw Error();}catch{await close();throw Error('Не удалось открыть локальную форму провайдера.');}
}
export async function closeProviderSessions():Promise<void>{await Promise.all([...active.values()].map(close=>close()));}
