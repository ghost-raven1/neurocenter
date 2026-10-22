import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createSessionReader,loadSession,CODEX_AUTH_MARKER} from './upstream/auth-session.js';
import {createCodexFetch} from './upstream/auth-provider.js';
import {beginCodexSetupLogin} from './codex-setup.mjs';

const run=promisify(execFile),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const denied=()=>new Error('Доступ к коннектору Codex изменился. Откройте настройки провайдера в Нейроцентре.');

/** The generated project wrapper contains identities and file paths, never account credentials. */
export function createManagedCodexPlugin(options){
    if(!options||!/^neurocenter-codex-[a-f0-9]{16}$/.test(options.providerId)||!path.isAbsolute(options.projectRoot)||typeof options.codexHome!=='string'||!path.isAbsolute(options.codexHome)
        ||!Array.isArray(options.bridgeCommand)||options.bridgeCommand.length!==2||options.bridgeCommand.some(value=>typeof value!=='string'||!path.isAbsolute(value))
        ||!uuid.test(options.preparationId)||!uuid.test(options.setupJobId)||!/^[a-f0-9]{64}$/.test(options.schemaDigest))throw denied();
    const owned={providerId:options.providerId,projectRoot:options.projectRoot,preparationId:options.preparationId,setupJobId:options.setupJobId,schemaDigest:options.schemaDigest};
    const command=[...options.bridgeCommand];
    const sessionReader=()=>createSessionReader(refresh=>loadSession(refresh,{env:{...process.env,CODEX_HOME:options.codexHome}}));
    let readCodexSession=sessionReader();
    async function permit(signal){
        signal?.throwIfAborted();
        try{
            const result=await run(command[0],[command[1],'--run','authorize_opencode_provider',JSON.stringify({...owned,phase:'request'})],{
                cwd:owned.projectRoot,timeout:30000,maxBuffer:65536,windowsHide:true,...(signal?{signal}:{}),
            });
            const response=JSON.parse(result.stdout);
            if(response.ok!==true||response.allowed!==true)throw denied();
            signal?.throwIfAborted();
        }catch(error){if(signal?.aborted)throw signal.reason;throw denied();}
    }
    return async input=>{
        if(!input||await realpath(input.directory)!==await realpath(owned.projectRoot))throw denied();
        const transport=createCodexFetch(async(refresh,signal)=>{await permit(signal);const session=await readCodexSession(refresh);signal?.throwIfAborted();return session;},async(url,init)=>{
            await permit(init?.signal);
            return fetch(url,init);
        });
        const runtimeOptions=()=>({apiKey:CODEX_AUTH_MARKER,baseURL:'https://chatgpt.com/backend-api/codex',fetch:transport});
        return {
            config(configuration){
                const provider=configuration?.provider?.[owned.providerId];if(!provider||typeof provider!=='object')throw denied();
                provider.options={...provider.options,...runtimeOptions()};
            },
            auth:{provider:owned.providerId,
            async loader(){return runtimeOptions();},
            methods:[{type:'api',label:'Использовать вход в ChatGPT на этом компьютере',async authorize(){await permit();await readCodexSession();return {type:'success',key:CODEX_AUTH_MARKER};}},
                {type:'oauth',label:'Войти в ChatGPT',async authorize(){await permit();const login=await beginCodexSetupLogin({codexHome:options.codexHome});return {url:login.url,instructions:'Завершите вход в открывшемся окне ChatGPT.',method:'auto',async callback(){await login.finished;readCodexSession=sessionReader();await permit();return {type:'success',key:CODEX_AUTH_MARKER};}};}}]}};
    };
}

// Installing the catalog asset is inert until the project wizard creates its owned provider wrapper.
export default async()=>({});
