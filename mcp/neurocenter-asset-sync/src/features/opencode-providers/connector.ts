import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {verify,type Package} from '../../bridge/package.js';
import {resolvePreparedRuntimeArtifact} from '../runtime-artifacts/cache.js';
import type {OpenCodeProviderDescriptor} from './contract.js';
import type {ProviderContext} from './context.js';
export interface CodexModel {id:string;name:string;inputModalities:string[]}
export interface CodexLogin {url:string;finished:Promise<void>;close:()=>Promise<void>}
interface CodexSetup {readCodexModels:(options?:{signal?:AbortSignal})=>Promise<{models:CodexModel[];defaultModel:string}>;beginCodexSetupLogin:(options?:{signal?:AbortSignal})=>Promise<CodexLogin>}
export const loginRequired=()=>Object.assign(new Error('Войдите в Codex на этом компьютере.'),{code:'CODEX_LOGIN_REQUIRED'});
/** Only the server-approved full package and pinned auth-only recipe may enter the existing runtime cache. */
export function connectorPackage(descriptor:OpenCodeProviderDescriptor,input:unknown):Package{
    const pkg=structuredClone(input) as Package;try{verify(pkg);}catch{throw new Error('Не подтверждена поставка коннектора Codex.');}
    const pin=descriptor.connector,meta=pkg.config?.extra?.codexConnector as Record<string,unknown>|undefined;
    if(descriptor.providerKind!=='codex-bridge'||!pin||pkg.plugin.kind!=='plugin'||pkg.plugin.id!==pin.assetId||pkg.plugin.version!==pin.version||pkg.manifest.sha256!==pin.manifest
        ||!meta||Object.keys(meta).sort().join(',')!=='authOnly,schemaVersion,sdkVersion,sourceCommit,version'||meta.schemaVersion!==1||meta.authOnly!==true||meta.sourceCommit!==pin.sourceCommit||meta.version!=='0.2.0'||meta.sdkVersion!=='0.159.3')throw new Error('Поставка коннектора не соответствует закреплённой версии.');
    return pkg;
}
/** Resolution rechecks archive inventory and every file; no npm, arbitrary module or PATH executable is loaded. */
export async function resolveConnector(context:ProviderContext){
    const pkg=connectorPackage(context.descriptor,context.connectorPackage),resolved=await resolvePreparedRuntimeArtifact(pkg);if(!resolved)throw new Error('Подготовьте готовый комплект коннектора Codex.');
    await context.assertCurrent();return {setupModule:pathToFileURL(path.join(resolved.root,'codex-setup.mjs')).href,pluginModule:pathToFileURL(path.join(resolved.root,'codex-plugin.mjs')).href};
}
export async function loadConnector(context:ProviderContext):Promise<{setup:CodexSetup;pluginModule:string}>{
    const {setupModule,pluginModule}=await resolveConnector(context),setup=await import(setupModule) as CodexSetup;
    if(typeof setup.readCodexModels!=='function'||typeof setup.beginCodexSetupLogin!=='function')throw new Error('Неподдерживаемый интерфейс коннектора.');
    return {setup,pluginModule};
}
export async function codexModels(context:ProviderContext,signal?:AbortSignal){
    signal?.throwIfAborted();const {setup}=await loadConnector(context),value=await setup.readCodexModels({signal});signal?.throwIfAborted();await context.assertCurrent();
    if(!value||!Array.isArray(value.models)||!value.models.length||value.models.length>100||typeof value.defaultModel!=='string')throw loginRequired();
    const models=value.models.map(item=>{if(!item||typeof item.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(item.id)||typeof item.name!=='string'||item.name.length>256||/[\x00-\x1f\x7f]/.test(item.name)||!Array.isArray(item.inputModalities)||item.inputModalities.some(x=>!['text','image'].includes(x)))throw new Error('Некорректные метаданные моделей Codex.');return {id:item.id,name:item.name,inputModalities:item.inputModalities};});
    if(new Set(models.map(m=>m.id)).size!==models.length||!models.some(m=>m.id===value.defaultModel))throw new Error('Некорректная модель Codex.');return {models,defaultModel:value.defaultModel};
}
export async function beginProviderLogin(context:ProviderContext,signal?:AbortSignal):Promise<CodexLogin>{
    signal?.throwIfAborted();const {setup}=await loadConnector(context),login=await setup.beginCodexSetupLogin({signal});let valid=false;
    try{const url=new URL(login.url);valid=login.url.length<=8192&&url.protocol==='https:'&&!url.username&&!url.password&&['auth.openai.com','chatgpt.com'].includes(url.hostname)&&typeof login.close==='function'&&login.finished instanceof Promise;}catch{}
    if(!valid){await login.close?.().catch(()=>{});throw new Error('Не подтверждён адрес входа Codex.');}let closing:Promise<void>|undefined;return {...login,close:()=>closing??=login.close()};
}
export async function codexDefinition(context:ProviderContext,selected:unknown,session:{preparationId:string;setupJobId:string},signal?:AbortSignal){
    const {models,defaultModel}=await codexModels(context,signal),model=typeof selected==='string'?selected:defaultModel;
    if(!models.some(item=>item.id===model))throw new Error('Выберите доступную модель Codex.');
    const {pluginModule}=await loadConnector(context),relative='.opencode/neurocenter/providers/'+context.descriptor.providerId+'.mjs';
    const codexHome=process.env.CODEX_HOME?path.resolve(process.env.CODEX_HOME):path.join(os.homedir(),'.codex');
    const options={providerId:context.descriptor.providerId,projectRoot:context.root,bridgeCommand:[process.execPath,fileURLToPath(new URL('../../index.js',import.meta.url))],...session,schemaDigest:context.descriptor.schemaDigest,codexHome};
    const content='import {createManagedCodexPlugin} from '+JSON.stringify(pluginModule)+';\nexport default createManagedCodexPlugin('+JSON.stringify(options)+');\n';
    return {entry:{npm:'@ai-sdk/openai',name:'Codex via ChatGPT',options:{baseURL:'https://chatgpt.com/backend-api/codex'},models:{[model]:{id:model,name:models.find(m=>m.id===model)!.name,...(models.find(m=>m.id===model)!.inputModalities.includes('image')?{modalities:{input:['text','image'],output:['text']}}:{})}}},files:[{relative,content}],plugin:pathToFileURL(path.join(context.root,relative)).href};
}
