import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { projectBindingId, projectFolder, projectInstanceId } from './workspace.js';
import { readBoundedSnapshot, fileFingerprint } from './read-bounded.js';
import type { IOpenCodeModelCandidate, IOpenCodeModelScan } from '../../../../services/shared/opencode-model-scan.cjs';
const shared=createRequire(import.meta.url)(fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../../../services/shared/opencode-model-scan.cjs':'../shared/opencode-model-scan.cjs',import.meta.url))) as typeof import('../../../../services/shared/opencode-model-scan.cjs');
type Json=Record<string,unknown>;
const object=(value:unknown):value is Json=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const id=(value:unknown):value is string=>text(value,200)&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)&&!value.includes('://');
const duplicate=(node:Node|undefined):boolean=>!!node&&((node.type==='object'&&new Set(node.children?.map(child=>child.children?.[0]?.value)).size!==node.children?.length)||!!node.children?.some(duplicate));
function merge(base:Json,next:Json):Json {
    for(const [key,value]of Object.entries(next)){
        if(['__proto__','constructor','prototype'].includes(key))continue;
        base[key]=object(base[key])&&object(value)?merge(base[key],value):value;
    }
    return base;
}
/** Базовый URL — metadata; ссылки env/file и секреты никогда не подставляются. */
function endpoint(value:unknown):{url:string|null;blocker:IOpenCodeModelCandidate['blocker']} {
    if(typeof value!=='string')return {url:null,blocker:'missing-endpoint'};
    if(/\{(?:env|file):/.test(value))return {url:null,blocker:'unresolved-endpoint'};
    try{const url=new URL(value);const host=url.hostname.toLowerCase();
        if(!text(value,1024)||!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||/[\\%\s]/.test(value)
            ||/^(?:169\.254\.|0\.0\.0\.0$|\[fe[89ab]|metadata(?:\.|$))/.test(host))throw Error();
        return {url:url.origin+url.pathname.replace(/\/+$/,''),blocker:null};
    }catch{return {url:null,blocker:'unsafe-endpoint'};}
}
/** Pure metadata projection: provider keys, custom headers and file contents are deliberately absent. */
export function opencodeModelCandidates(config:Json,auth:Json={}):IOpenCodeModelCandidate[] {
    const providers:Json=JSON.parse(JSON.stringify(object(config.provider)?config.provider:{}));
    for(const selected of [config.model,config.small_model]){
        if(typeof selected!=='string'||!selected.includes('/'))continue;
        const [provider,...parts]=selected.split('/'),model=parts.join('/');
        if(!provider||!id(provider)||!id(model))continue;
        const entry=object(providers[provider])?providers[provider]:{};
        const models=object(entry.models)?entry.models:{};
        if(!models[model])models[model]={};entry.models=models;providers[provider]=entry;
    }
    const result:IOpenCodeModelCandidate[]=[];
    for(const [provider,value]of Object.entries(providers)){
        if(!id(provider)||provider.length>128||!object(value))continue;
        const options=object(value.options)?value.options:{};
        const models=object(value.models)?value.models:{};
        const knownOpenai=provider==='openai'&&(!value.npm||value.npm==='@ai-sdk/openai');
        const supported=(knownOpenai||['@ai-sdk/openai-compatible','@ai-sdk/openai'].includes(String(value.npm)))&&!options.headers;
        const address=endpoint(options.baseURL??(knownOpenai?'https://api.openai.com/v1':undefined));
        const key=options.apiKey;
        const credentialSource:IOpenCodeModelCandidate['credentialSource']=typeof key==='string'&&key?key.includes('{env:')?'environment':key.includes('{file:')?'file':'inline':object(auth[provider])?'auth':'none';
        for(const [model,metadata]of Object.entries(models)){
            if(!id(model)||model.length>128||!object(metadata)||result.length>=100)continue;
            const modalities=object(metadata.modalities)?metadata.modalities:{};
            const disabled=Array.isArray(config.disabled_providers)&&config.disabled_providers.includes(provider)
                ||Array.isArray(config.enabled_providers)&&!config.enabled_providers.includes(provider);
            const overridden=object(metadata.provider)||object(metadata.options)&&Object.keys(metadata.options).length>0;
            result.push({candidateId:randomUUID(),provider,name:text(metadata.name,128)?metadata.name:model,model,modelVersion:model,
                capability:Array.isArray(modalities.input)&&modalities.input.includes('image')?'vision':'chat',runtime:supported?'remote-openai':null,
                baseUrl:address.url,hasKey:credentialSource!=='none',credentialSource,
                blocker:disabled?'disabled-provider':!supported||overridden?'unsupported-provider':address.blocker});
        }
    }
    return result;
}

/** Читает документированные конфиги выбранного проекта и пользователя, без рекурсивного сканирования home. */
export async function readOpenCodeModelMetadata(root:string,context:{projectId:string;bindingId:string;instanceId:string},options:{home?:string;environment?:NodeJS.ProcessEnv;authorize?:()=>Promise<unknown>}={}):Promise<IOpenCodeModelScan> {
    const home=options.home??os.homedir(),env=options.environment??process.env,authorize=options.authorize??(async()=>{});
    const warnings=new Set<string>(['ancestor-config-not-scanned','organization-config-not-scanned',...(process.platform==='darwin'?['managed-preferences-not-scanned']:[])]);
    const snapshots:Array<{file:string;fingerprint:string}>=[];
    const read=async(file:string):Promise<Json|null>=>{
        await authorize();
        try{
            const parsed=path.parse(path.resolve(file));let current=parsed.root;
            for(const part of path.resolve(file).slice(parsed.root.length).split(path.sep)){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw Error('unsafe-path');}
            const snapshot=await readBoundedSnapshot(file,1024*1024);snapshots.push({file,fingerprint:snapshot.fingerprint});
            const source=snapshot.bytes.toString('utf8'),errors:ParseError[]=[];const value:unknown=parse(source,errors,{allowTrailingComma:true});
            if(errors.length||!object(value)||!Buffer.from(source).equals(snapshot.bytes)||duplicate(parseTree(source))){warnings.add('invalid-json');return null;}
            if(snapshot.bytes.includes(Buffer.from('{file:')))warnings.add('file-reference-not-expanded');
            if(snapshot.bytes.includes(Buffer.from('{env:')))warnings.add('env-reference-not-expanded');
            return value;
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')warnings.add((error as Error).message==='unsafe-path'?'unsafe-path':'read-failed');return null;}
    };
    let config:Json={};
    const layer=async(directory:string):Promise<void>=>{
        const json=await read(path.join(directory,'opencode.json')),jsonc=await read(path.join(directory,'opencode.jsonc'));
        // Одновременные файлы не выбираются молча: OpenCode version-specific precedence надо уточнить на компьютере.
        if(json&&jsonc){warnings.add('ambiguous-config');return;}
        if(json||jsonc)config=merge(config,(json??jsonc)!);
    };
    await layer(path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'opencode'));
    if(env.OPENCODE_CONFIG){const value=await read(path.resolve(root,env.OPENCODE_CONFIG));if(value)config=merge(config,value);}
    await layer(root);await layer(path.join(root,'.opencode'));
    if(env.OPENCODE_CONFIG_DIR)await layer(path.resolve(root,env.OPENCODE_CONFIG_DIR));
    if(env.OPENCODE_CONFIG_CONTENT){const errors:ParseError[]=[];const value:unknown=env.OPENCODE_CONFIG_CONTENT.length<=1024*1024?parse(env.OPENCODE_CONFIG_CONTENT,errors,{allowTrailingComma:true}):null;if(!errors.length&&object(value)&&!duplicate(parseTree(env.OPENCODE_CONFIG_CONTENT)))config=merge(config,value);else warnings.add('invalid-json');}
    const managed=process.platform==='darwin'?'/Library/Application Support/opencode':process.platform==='win32'?env.ProgramData&&path.join(env.ProgramData,'opencode'):'/etc/opencode';
    if(managed)await layer(managed);
    const auth=await read(path.join(env.XDG_DATA_HOME||path.join(home,'.local','share'),'opencode','auth.json'));
    await authorize();
    for(const snapshot of snapshots){try{if(fileFingerprint(await fs.lstat(snapshot.file,{bigint:true}))!==snapshot.fingerprint)warnings.add('source-changed');}catch{warnings.add('source-changed');}}
    let candidates=opencodeModelCandidates(config,auth??{});
    if(object(config.provider)&&Object.values(config.provider).reduce<number>((sum,value)=>sum+(object(value)&&object(value.models)?Object.keys(value.models).length:0),0)>100)warnings.add('entry-limit');
    if(warnings.has('source-changed')||warnings.has('ambiguous-config')||warnings.has('invalid-json')||warnings.has('unsafe-path')||warnings.has('read-failed'))candidates=[];
    const now=new Date();const scan:IOpenCodeModelScan={schemaVersion:1,...context,scanId:randomUUID(),checkedAt:now.toISOString(),expiresAt:new Date(now.getTime()+900000).toISOString(),warnings:[...warnings],candidates,digest:''};
    scan.digest=shared.modelScanDigest(scan);
    if(!shared.validModelScan(scan,context))throw Error('Метаданные моделей не прошли проверку формата.');
    return scan;
}
export async function scanOpenCodeModels(projectId:string,authorize:()=>Promise<unknown>):Promise<IOpenCodeModelScan> {
    await authorize();const root=await projectFolder(projectId),bindingId=await projectBindingId(projectId),instanceId=await projectInstanceId(projectId);
    const result=await readOpenCodeModelMetadata(root,{projectId,bindingId,instanceId},{authorize});
    await authorize();if(bindingId!==await projectBindingId(projectId)||instanceId!==await projectInstanceId(projectId))throw Error('Папка проекта изменилась во время чтения.');
    return result;
}
