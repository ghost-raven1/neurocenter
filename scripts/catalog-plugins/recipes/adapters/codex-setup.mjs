import {invalidateCodexSession} from './upstream/auth-session.js';
import {beginCodexLogin} from './upstream/auth-login.js';
import {CodexConnection} from './upstream/connection.js';
import {z} from 'zod';

const statusSchema=z.object({authMethod:z.string().nullable()});
const modelSchema=z.object({model:z.string(),displayName:z.string(),isDefault:z.boolean(),hidden:z.boolean(),inputModalities:z.array(z.string()),defaultReasoningEffort:z.string(),supportedReasoningEfforts:z.array(z.object({reasoningEffort:z.string()}))});
const failure=(code,message)=>Object.assign(new Error(message),{code});

function connectionFor(signal,codexHome){
    signal?.throwIfAborted();const connection=new CodexConnection(undefined,[],codexHome?{...process.env,CODEX_HOME:codexHome}:undefined);let closing;
    const close=()=>closing??=connection.close(),abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});
    return {connection,async close(){signal?.removeEventListener('abort',abort);await close();}};
}

/** Model discovery reads account metadata only; it never starts a generation. */
export async function readCodexModels({signal:external,codexHome}={}){
    const signal=external?AbortSignal.any([external,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),owned=connectionFor(signal,codexHome);
    const call=async(method,params)=>{signal.throwIfAborted();const result=await owned.connection.call(method,params);signal.throwIfAborted();return result;};
    try{
        await owned.connection.initialize();signal.throwIfAborted();
        const status=statusSchema.parse(await call('getAuthStatus',{includeToken:false,refreshToken:false}));
        if(status.authMethod!=='chatgpt')throw failure('CODEX_LOGIN_REQUIRED','Войдите в ChatGPT на этом компьютере и повторите проверку.');
        const models=[],seen=new Set();let cursor=null;
        do{
            if(cursor&&seen.has(cursor)||seen.size>=20)throw Error();if(cursor)seen.add(cursor);
            const page=z.object({data:z.array(modelSchema),nextCursor:z.string().nullable()}).parse(await call('model/list',{limit:100,cursor,includeHidden:false}));
            for(const model of page.data.filter(value=>!value.hidden))models.push({id:model.model,name:model.displayName,isDefault:model.isDefault,inputModalities:model.inputModalities,defaultReasoningEffort:model.defaultReasoningEffort,reasoningEfforts:model.supportedReasoningEfforts.map(option=>option.reasoningEffort)});
            if(models.length>100)throw Error();cursor=page.nextCursor;
        }while(cursor);
        if(!models.length||new Set(models.map(model=>model.id)).size!==models.length)throw Error();
        const configuration=z.object({config:z.object({model:z.string().nullable().optional()}).passthrough()}).parse(await call('config/read',{includeLayers:false}));
        return {models,defaultModel:(models.find(model=>model.id===configuration.config.model)??models.find(model=>model.isDefault)??models[0]).id};
    }catch(error){
        if(external?.aborted)throw external.reason;
        if(error?.code==='CODEX_LOGIN_REQUIRED')throw error;
        throw failure('CODEX_DISCOVERY_UNAVAILABLE','Не удалось получить модели Codex. Повторите проверку подключения.');
    }finally{await owned.close();}
}

/** Codex owns credentials; closing the setup page also closes the official login process. */
export async function beginCodexSetupLogin({signal,codexHome}={}){
    const owned=connectionFor(signal,codexHome);
    try{
        const login=await beginCodexLogin(owned.connection,invalidateCodexSession);signal?.throwIfAborted();
        const finished=login.callback().then(()=>undefined).catch(()=>{throw new Error('Вход не завершён. Можно повторить его, сохранив настройки.');}).finally(()=>owned.close());
        void finished.catch(()=>undefined);
        return {url:login.url,finished,close:()=>owned.close()};
    }catch{await owned.close();if(signal?.aborted)throw signal.reason;throw new Error('Не удалось открыть вход в ChatGPT. Повторите попытку.');}
}
