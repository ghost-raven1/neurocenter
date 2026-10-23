import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {ConfigurationContext,Authorize} from './context.js';
import {ConfigurationEditor} from './engine.js';
import {configurationPage} from './page.js';
const active=new Map<string,()=>Promise<void>>();
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req:IncomingMessage){if(req.headers['content-type']!=='application/json')throw Error();let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const bytes=Buffer.from(chunk);if((size+=bytes.length)>600*1024)throw Error();chunks.push(bytes);}const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;}
const exact=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const safeMessage=(error:unknown)=>{
    const text=error instanceof Error?error.message:'';
    const prefixes=['Файлы изменились','Файл изменился','Файл агента изменён','Файл настройки превышает','Файл превышает','Текст превышает','Исправьте синтаксис','Нужен JSON-объект','Количество результатов:','Минимальная оценка:','Проверьте список расширений','Модель и хранилище управляются','Управляемые агенты и подключения','Управляемый плагин','Управляемая установка не подтверждена','Этот файл принадлежит','Сначала примените агентов сайта','Маркеры раздела агентов конфликтуют','Подключение уже управляется','Мастер недоступен','RAG больше не подтверждён'];
    return prefixes.some(prefix=>text.startsWith(prefix))?text.slice(0,400):'Действие недоступно. Проверьте права, флаг функции и срок мастера. Черновик остаётся в форме; скопируйте его перед повторным открытием.';
};
/** One-use fragment capability, same-origin CSRF, local-only text and a fresh permit for every operation. */
export async function startConfigurationSession(context:ConfigurationContext,authorize:Authorize,open:(url:string)=>Promise<boolean>):Promise<void>{
    const id=context.descriptor.sessionId;if(active.has(id))throw Error('Мастер уже открыт.');
    await authorize();await context.assertCurrent();const deadline=Date.parse(context.descriptor.expiresAt),token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),nonce=randomBytes(24).toString('base64url');
    let closed=false,used=false,busy=false,closing:Promise<void>|undefined;const lifecycle=new AbortController();
    const current=()=>{lifecycle.signal.throwIfAborted();if(closed||Date.now()>=deadline)throw Error();};
    const server=createServer((req,res)=>{let abandoned=false;res.once('close',()=>{if(!res.writableEnded)abandoned=true;});const requestCurrent=()=>{current();if(abandoned)throw Error();};
        void(async()=>{
            current();const address=server.address();if(!address||typeof address==='string')throw Error();const host='127.0.0.1:'+address.port,origin='http://'+host;
            if(req.headers.host!==host||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')){json(res,403,{});return;}
            if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});res.end(configurationPage.replace('<style>',`<style nonce="${nonce}">`).replace('<script>',`<script nonce="${nonce}">`));return;}
            if(req.method!=='POST'||req.headers.origin!==origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'){json(res,403,{});return;}
            const value=await body(req);requestCurrent();
            if(req.url==='/session'&&!used&&Object.keys(value).length===1&&value.token===token){used=true;await authorize();requestCurrent();await context.assertCurrent();json(res,200,{csrf,expiresAt:context.descriptor.expiresAt,settingsUrl:context.site+'/projects/'+encodeURIComponent(context.descriptor.projectId)+'?tab=store&catalogTab=models'});return;}
            if(!used||req.headers['x-configuration-csrf']!==csrf){json(res,403,{});return;}
            if(req.url==='/close'&&Object.keys(value).length===0){json(res,200,{closed:true});setImmediate(()=>void close());return;}
            if(busy){json(res,409,{message:'Дождитесь завершения текущего действия. Черновик сохранён.'});return;}busy=true;
            try{const editorCurrent=()=>requestCurrent();const editorForRequest=editor;requestCurrent();editorRequestCurrent=editorCurrent;
                let result:unknown;
                if(req.url==='/inventory'&&Object.keys(value).length===0)result=await editorForRequest.inventory();
                else if(req.url==='/read'&&exact(value,['path']))result=await editorForRequest.read(value.path);
                else if(req.url==='/preview'&&exact(value,['path','revision','text','rag','agentSection','draft']))result=await editorForRequest.prepare(value);
                else if(req.url==='/save'&&exact(value,['previewId','digest']))result=await editorForRequest.save(value);
                else {json(res,400,{});return;}requestCurrent();json(res,200,result);
            }finally{editorRequestCurrent=()=>current();busy=false;}
        })().catch(error=>{if(!res.headersSent)json(res,(error as {code?:string})?.code==='PROJECT_CONFIGURATION_CONFLICT'?409:400,{message:safeMessage(error)});else res.end();});
    });
    let editorRequestCurrent=()=>current();const editor=new ConfigurationEditor(context,authorize,()=>editorRequestCurrent());
    server.requestTimeout=10000;server.headersTimeout=5000;server.maxHeadersCount=30;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const close=()=>closing??=(async()=>{closed=true;lifecycle.abort();clearTimeout(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));active.delete(id);})();
    const timer=setTimeout(()=>void close(),Math.max(1,deadline-Date.now()));timer.unref();server.unref();active.set(id,close);
    try{const address=server.address();if(!address||typeof address==='string'||!await open('http://127.0.0.1:'+address.port+'/#'+token))throw Error();}catch{await close();throw Error('Не удалось открыть локальный мастер конфигурации.');}
}
export async function closeConfigurationSessions(){await Promise.all([...active.values()].map(close=>close()));}
