import {createOllama as nativeOllama} from '@neurocenter/ollama-runtime';

type NativeProvider=ReturnType<typeof nativeOllama>;
type NativeModel=ReturnType<NativeProvider['languageModel']>;
type Call=Parameters<NativeModel['doGenerate']>[0];
interface Settings {name?:string;baseURL:string;apiKey?:string;fetch?:typeof fetch}

/** OpenCode 1.14 uses a provider-ID namespace; the pinned SDK expects Ollama's native namespace and options. */
function nativeCall(call:Call,provider:string):Call{
    const values=call.providerOptions?.[provider]??{},options:Record<string,number>={};
    for(const [field,wire,fallback]of [['temperature','temperature',call.temperature],['topP','top_p',call.topP],['maxOutputTokens','num_predict',call.maxOutputTokens],['contextWindow','num_ctx',undefined]] as const){
        const value=values[field]??fallback;
        if(value!==undefined){if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Некорректные параметры Ollama.');options[wire]=value;}
    }
    if(Object.keys(values).some(key=>!['temperature','topP','maxOutputTokens','contextWindow'].includes(key)))throw new Error('Параметры Ollama изменились. Перепроверьте подключение.');
    const prompt=call.prompt.map(message=>message.role!=='user'?message:{...message,content:message.content.map(part=>{
        if(part.type!=='file')return part;
        if(!part.mediaType.startsWith('image/')||part.data instanceof URL)throw new Error('Для Ollama передайте файл изображения или текст документа.');
        return {...part,data:part.data instanceof Uint8Array?Buffer.from(part.data).toString('base64'):part.data};
    })});
    return {...call,prompt,providerOptions:{ollama:{options}}};
}

/** Native /api/chat transport with optional bearer auth, tool calls, abort and streaming owned by the pinned Provider V3 SDK. */
export function createOllama(settings:Settings):NativeProvider{
    const name=settings.name??'ollama',url=new URL(settings.baseURL);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||settings.baseURL!==url.href.replace(/\/+$/,''))throw new Error('Некорректный адрес Ollama.');
    if(settings.apiKey!==undefined&&(typeof settings.apiKey!=='string'||!settings.apiKey||/[\x00-\x20\x7f{}]/.test(settings.apiKey)))throw new Error('Некорректный локальный ключ Ollama.');
    const native=nativeOllama({name,baseURL:settings.baseURL+'/api',...(settings.apiKey?{headers:{Authorization:'Bearer '+settings.apiKey}}:{}),...(settings.fetch?{fetch:settings.fetch}:{})});
    const languageModel=(id:Parameters<NativeProvider['languageModel']>[0]):NativeModel=>{
        const model=native.languageModel(id);
        return new Proxy(model,{get(target,key,receiver){
            if(key==='supportedUrls')return {};
            if(key==='doGenerate')return async(call:Call)=>target.doGenerate(nativeCall(call,name));
            if(key==='doStream')return async(call:Call)=>target.doStream(nativeCall(call,name));
            return Reflect.get(target,key,receiver);
        }});
    };
    return Object.assign((id:Parameters<NativeProvider['languageModel']>[0])=>languageModel(id),native,{languageModel,chat:languageModel});
}
