import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {applyEdits,modify} from 'jsonc-parser';
import {configurationObject,object} from '../project-configuration/json.js';
import {contract,type GlobalProvidersLimits,type GlobalProvidersIssue,type OpenCodeGlobalProvidersInventory,type GlobalProvider} from './contract.js';
import {snapshot,unchanged,publish,conflict,type LocalSnapshot} from './files.js';
import {ProviderTransactions} from './transaction.js';

export interface CompatibleCliProof {assertCurrent:()=>Promise<void>}
interface Options {home:string;environment:NodeJS.ProcessEnv;authorize:()=>Promise<unknown>;assertCompatibleCli?:()=>Promise<CompatibleCliProof>;current?:()=>void;limits?:Readonly<GlobalProvidersLimits>}
interface Change {before:LocalSnapshot;after:string}
interface Preview {previewId:string;changes:Change[];snapshots:LocalSnapshot[];providerId:string}
interface Input {providerId?:unknown;authentication?:unknown;apiKey?:unknown;baseURL?:unknown;modelIds?:unknown}
/** Only fixed local validation text is eligible for display; transport/filesystem errors never echo input values. */
export class GlobalProviderInputError extends Error {}
const merge=(a:Record<string,unknown>,b:Record<string,unknown>):Record<string,unknown>=>{const result={...a};for(const [key,value]of Object.entries(b)){if(['__proto__','constructor','prototype'].includes(key))throw conflict();result[key]=object(value)&&object(result[key])?merge(result[key] as Record<string,unknown>,value):value;}return result;};
function authKind(value:unknown):GlobalProvider['authentication']{
    if(value===undefined)return 'none';if(!object(value))return 'unknown';
    const metadata=value.metadata===undefined||object(value.metadata)&&Object.values(value.metadata).every(item=>typeof item==='string');
    if(value.type==='api'&&typeof value.key==='string'&&!!value.key&&metadata)return 'api';
    if(value.type==='oauth'&&typeof value.access==='string'&&typeof value.refresh==='string'&&Number.isSafeInteger(value.expires)&&Number(value.expires)>=0
        &&['accountId','enterpriseUrl'].every(key=>value[key]===undefined||typeof value[key]==='string'))return 'oauth';
    if(value.type==='wellknown'&&typeof value.key==='string'&&typeof value.token==='string')return 'wellknown';
    return 'unknown';
}
const update=(text:string|null,keys:string[],value:unknown)=>applyEdits(text??'{}\n',modify(text??'{}\n',keys,value,{formattingOptions:{insertSpaces:true,tabSize:2}}));

/** Global inventory is local metadata, not SDK discovery, a default-model choice or a paid readiness probe. */
export class GlobalProviderEditor {
    readonly limits:Readonly<GlobalProvidersLimits>;
    readonly configDirectory:string;readonly authFile:string;
    private readonly configurations:string[];private preview?:Preview;private busy=false;private readonly transactions:ProviderTransactions;
    constructor(private readonly options:Options){
        this.limits=options.limits??contract.globalProvidersLimits(options.environment);
        this.configDirectory=path.join(options.environment.XDG_CONFIG_HOME||path.join(options.home,'.config'),'opencode');
        this.authFile=path.join(options.environment.XDG_DATA_HOME||path.join(options.home,'.local/share'),'opencode','auth.json');
        this.configurations=['config.json','opencode.json','opencode.jsonc'].map(name=>path.join(this.configDirectory,name));
        this.transactions=new ProviderTransactions(options.home,options.environment,[...this.configurations,this.authFile],this.limits.fileBytes,()=>this.admit());
    }
    private async admit(){this.options.current?.();await this.options.authorize();this.options.current?.();}
    private async compatible(){
        await this.admit();if(!this.options.assertCompatibleCli)throw Object.assign(Error('Локальное сохранение поддерживает только подтверждённый обычный OpenCode1.14.48. Чтение доступно.'),{code:'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'});
        const proof=await this.options.assertCompatibleCli();await this.admit();await proof.assertCurrent();return proof;
    }
    private async read(){
        await this.admit();const snapshots:LocalSnapshot[]=[];let config:Record<string,unknown>={};
        for(const file of this.configurations){const item=await snapshot(file,this.limits.fileBytes,false);snapshots.push(item);if(item.text!==null)config=merge(config,configurationObject(item.text));}
        const auth=await snapshot(this.authFile,this.limits.fileBytes,true);snapshots.push(auth);const authentication=configurationObject(auth.text,true);
        for(const item of snapshots)await unchanged(item,this.limits.fileBytes);await this.admit();return{config,authentication,snapshots};
    }
    async inventory():Promise<OpenCodeGlobalProvidersInventory>{
        const issues=new Set<GlobalProvidersIssue>(),environment=this.options.environment;
        const overrideDetected=!!(environment.OPENCODE_AUTH_CONTENT||environment.OPENCODE_CONFIG||environment.OPENCODE_CONFIG_CONTENT||environment.OPENCODE_CONFIG_DIR);
        if(overrideDetected)issues.add('environment-override');
        try{
            const pending=await this.transactions.inspect();if(pending&&pending.status!=='saved')issues.add('source-changed');
            const {config,authentication,snapshots}=await this.read(),providers:GlobalProvider[]=[];
            const entries=object(config.provider)?config.provider:{};
            const ids=[...new Set([...Object.keys(entries),...Object.keys(authentication)])].sort();
            for(const id of ids){
                if(!contract.globalProviderId(id)){issues.add('entry-limit');continue;}if(providers.length>=this.limits.providers){issues.add('entry-limit');break;}
                const provider=object(entries[id])?entries[id] as Record<string,unknown>:{},options=object(provider.options)?provider.options:{};
                let modelIds=object(provider.models)?Object.keys(provider.models).filter(contract.globalProviderModelId).sort():[];
                if(object(provider.models)&&Object.keys(provider.models).length!==modelIds.length)issues.add('entry-limit');
                if(modelIds.length>this.limits.modelsPerProvider){modelIds=modelIds.slice(0,this.limits.modelsPerProvider);issues.add('entry-limit');}
                const stored=authKind(authentication[id]),apiKey=options.apiKey;
                const authenticationKind=typeof apiKey==='string'&&!!apiKey?(apiKey.includes('{env:')||apiKey.includes('{file:')?'reference':'api'):stored;
                providers.push({id,modelIds,hasConfiguration:Object.hasOwn(entries,id),hasAuthentication:authenticationKind!=='none'&&authenticationKind!=='unknown',authentication:authenticationKind,
                    enabled:!Array.isArray(config.disabled_providers)||!config.disabled_providers.includes(id)});
                if(Array.isArray(config.enabled_providers))providers.at(-1)!.enabled&&=config.enabled_providers.includes(id);
                if(Buffer.byteLength(JSON.stringify(providers))>Math.max(1,this.limits.publicBytes-512)){providers.pop();issues.add('entry-limit');break;}
            }
            return contract.normalizeGlobalProvidersInventory({providers,configurationFound:snapshots.slice(0,-1).some(item=>item.text!==null),authenticationFound:snapshots.at(-1)!.text!==null,overrideDetected,issues:[...issues]});
        }catch(error){
            await this.admit();const code=(error as {code?:string}).code;
            issues.add(code==='GLOBAL_PROVIDER_UNSAFE'?'unsafe-file':code==='ESTALE'||code==='GLOBAL_PROVIDER_CONFLICT'?'source-changed':error instanceof Error&&error.message.startsWith('Нужен JSON')||error instanceof Error&&error.message.startsWith('Исправьте синтаксис')?'invalid-json':'read-failed');
            return{providers:[],configurationFound:false,authenticationFound:false,overrideDetected,issues:[...issues]};
        }
    }
    async prepare(input:Input){
        if(this.busy||!object(input)||Object.keys(input).some(key=>!['providerId','authentication','apiKey','baseURL','modelIds'].includes(key))||!contract.globalProviderId(input.providerId)||!['keep','api','none'].includes(String(input.authentication)))throw conflict();
        if((await this.inventory()).overrideDetected)throw new GlobalProviderInputError('Глобальная настройка переопределена окружением. Измените её в OpenCode; локальные файлы сохранены.');
        const pending=await this.transactions.inspect();if(pending&&pending.status!=='saved')throw new GlobalProviderInputError('Сначала проверьте исход предыдущего сохранения. Новый запрос не заменяет сохранённое изменение.');
        const {config,authentication,snapshots}=await this.read(),id=input.providerId,entries=object(config.provider)?config.provider:{},provider=object(entries[id])?entries[id] as Record<string,unknown>:{},providerOptions=object(provider.options)?provider.options:{};
        const changes:Change[]=[],kind=authKind(authentication[id]),apiKey=input.apiKey;
        if(input.authentication==='api'){
            if(typeof apiKey!=='string'||!apiKey||Buffer.byteLength(apiKey)>this.limits.secretBytes||/[\x00-\x20\x7f]/.test(apiKey))throw new GlobalProviderInputError('Введите ключ в локальной форме.');
            if(kind!=='none'&&kind!=='api')throw new GlobalProviderInputError('OAuth или ручная авторизация этого провайдера сохраняется. Измените её явно через OpenCode.');
            if(Object.hasOwn(providerOptions,'apiKey'))throw new GlobalProviderInputError('Ключ задан ручной конфигурацией провайдера. Измените его в исходной настройке OpenCode; файл auth не заменён.');
            const before=snapshots.at(-1)!;changes.push({before,after:update(before.text,[id],{...(object(authentication[id])?authentication[id]:{}),type:'api',key:apiKey})});
        }else if(input.apiKey!==undefined)throw new GlobalProviderInputError('Ключ разрешён только для выбранной API-авторизации.');
        if(input.authentication==='none'&&(kind!=='none'||Object.hasOwn(providerOptions,'apiKey')))throw new GlobalProviderInputError('Существующая авторизация сохранена. Режим без ключа доступен для нового локального провайдера.');
        if(input.baseURL!==undefined||input.modelIds!==undefined){
            if(!['none','api'].includes(kind))throw new GlobalProviderInputError('OAuth и ручной механизм авторизации сохраняются. Для другого адреса используйте новый идентификатор провайдера.');
            if(typeof input.baseURL!=='string'||!Array.isArray(input.modelIds)||!input.modelIds.length||input.modelIds.length>this.limits.modelsPerProvider||input.modelIds.some(id=>!contract.globalProviderModelId(id))||new Set(input.modelIds).size!==input.modelIds.length)throw new GlobalProviderInputError('Укажите адрес и разные идентификаторы моделей.');
            let url:URL;try{url=new URL(input.baseURL);}catch{throw new GlobalProviderInputError('Проверьте адрес API.');}
            if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw new GlobalProviderInputError('Адрес API не должен содержать ключ, пароль, параметры или фрагмент.');
            if(Object.hasOwn(entries,id))throw new GlobalProviderInputError('Ручная конфигурация этого провайдера сохраняется. Новый адрес и модели добавляются только новому провайдеру.');
            const before=[...snapshots.slice(0,-1)].reverse().find(item=>item.text!==null)??snapshots[2]!;
            const models=Object.fromEntries(input.modelIds.map(model=>[model,{name:model}]));
            changes.unshift({before,after:update(before.text,['provider',id],{npm:'@ai-sdk/openai-compatible',options:{baseURL:input.baseURL},models})});
        }
        if(!changes.length)throw new GlobalProviderInputError('Нет выбранного изменения. Текущую настройку можно использовать без сохранения.');
        if(changes.some(item=>Buffer.byteLength(item.after)>this.limits.fileBytes))throw new GlobalProviderInputError('Изменение превышает локальный лимит файла.');
        for(const item of snapshots)await unchanged(item,this.limits.fileBytes);await this.admit();
        const previewId=randomUUID();this.preview={previewId,changes,snapshots,providerId:id};return{previewId,providerId:id,configurationChanged:changes.some(item=>!item.before.secret),authenticationChanged:changes.some(item=>item.before.secret)};
    }
    async save(input:{previewId?:unknown}){
        if(this.busy||!this.preview||input.previewId!==this.preview.previewId)throw conflict();this.busy=true;
        try{
            const preview=this.preview;await this.admit();const cli=await this.compatible();for(const item of preview.snapshots)await unchanged(item,this.limits.fileBytes);
            // A failure after the first publication must never replay the remaining writes implicitly.
            let published=0;const intent=await this.transactions.begin(preview.providerId,preview.changes);this.preview=undefined;
            try{for(const change of preview.changes){
                const verify=async()=>{await cli.assertCurrent();for(const item of preview.snapshots)await unchanged(item,this.limits.fileBytes);};
                await publish(change.before,change.after,this.limits.fileBytes,()=>this.admit(),verify);published++;
                const current=await snapshot(change.before.file,this.limits.fileBytes,change.before.secret);preview.snapshots=preview.snapshots.map(item=>item.file===current.file?current:item);
            }}catch(error){this.preview=undefined;if(published)throw Object.assign(Error('Сохранение выполнено частично. Перечитайте локальные файлы перед новым изменением; автоматический повтор запрещён.'),{code:'GLOBAL_PROVIDER_UNKNOWN'});throw error;}
            await this.transactions.complete(intent.id);this.preview=undefined;return{saved:true,providerId:preview.providerId,note:'Сохранено локально. OpenCode перечитает настройку при следующем запуске. Запрос модели не выполнялся.'};
        }finally{this.busy=false;}
    }
    async lastSave(){await this.admit();return this.transactions.inspect();}
    /** Explicit recovery reconciles exact local before/after bytes; it never repeats an already published file. */
    async resume(input:{intentId?:unknown}){
        if(this.busy)throw conflict();this.busy=true;
        try{
            await this.admit();const cli=await this.compatible();const {intent}=await this.transactions.read(),status=await this.transactions.inspect();
            if(!intent||intent.id!==input.intentId||status?.status==='conflict')throw conflict();
            const snapshots=await Promise.all(intent.changes.map(item=>snapshot(item.before.file,this.limits.fileBytes,item.before.secret)));
            for(const item of intent.changes){
                let current=snapshots.find(value=>value.file===item.before.file)!;if(current.text===item.after)continue;if(current.text!==item.before.text)throw conflict();
                const verify=async()=>{await cli.assertCurrent();for(const value of snapshots)await unchanged(value,this.limits.fileBytes);};
                await publish(current,item.after,this.limits.fileBytes,()=>this.admit(),verify);current=await snapshot(current.file,this.limits.fileBytes,current.secret);snapshots[snapshots.findIndex(value=>value.file===current.file)]=current;
            }
            await this.transactions.complete(intent.id);return{saved:true,providerId:intent.providerId};
        }finally{this.busy=false;}
    }
}
