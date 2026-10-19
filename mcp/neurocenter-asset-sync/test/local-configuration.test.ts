import fs from 'node:fs/promises';
import path from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceFixture } from './bridge-fixture.js';
import { rehashPackage, setPackage, setFixture } from './install-set-fixture.js';
import { install, installSet } from '../src/bridge/installer.js';
import { hash, stateDir, writeState } from '../src/bridge/state.js';
import { configurationContext } from '../src/features/local-configuration/context.js';
import { parseLocalConfiguration, localConfigurationDigest, validateConfigurationValues, type LocalConfigurationSchema } from '../src/features/local-configuration/schema.js';
import { ensureMcpConfigurationLauncher, getMcpConfigurationStatus, openMcpConfiguration, prepareMcpConfiguration, prepareMcpConfigurationLauncher, readMcpConfiguration } from '../src/features/local-configuration/index.js';
import { closeConfigurationSessions } from '../src/features/local-configuration/server.js';
import { readPrivateConfiguration, writePrivateConfiguration } from '../src/features/local-configuration/private-store.js';
import { saveConfiguration } from '../src/features/local-configuration/state.js';
import { configurationConnection } from '../src/features/local-configuration/launcher-descriptor.js';
import { launcherDescriptorKey, type LauncherDescriptor } from '../src/features/local-configuration/launcher-descriptor.js';
import { assetKey } from '../src/bridge/installation-receipt.js';

const noop = async()=>{};
const schema:LocalConfigurationSchema = {schemaVersion:1,fields:[
    {id:'apiKey',label:'Ключ доступа',type:'string',required:true,secret:true,target:{kind:'env',name:'TEST_API_KEY'}},
    {id:'enabled',label:'Включить режим',type:'boolean',required:false,target:{kind:'env',name:'TEST_ENABLED'}},
]};
function configuredPackage() {
    const pkg = setPackage('configured-mcp'); pkg.schemaVersion=5;
    pkg.config={...pkg.config,extra:{localConfiguration:structuredClone(schema)}}; return rehashPackage(pkg);
}
describe('Локальная настройка MCP',()=>{
    let temporary=''; let root='';
    beforeEach(async()=>{({temporary,root}=await workspaceFixture()); await writeState('credentials',{deviceId:'test-device',token:'НЕ_ВЫВОДИТЬ',email:'test@example.org'});});
    afterEach(async()=>{closeConfigurationSessions();vi.unstubAllEnvs();await fs.rm(temporary,{recursive:true,force:true});});
    async function setup(){const pkg=configuredPackage();await install('test-project',pkg,noop,noop);return pkg;}
    async function opened(pkg= configuredPackage(),authorizeSave=noop){
        const prepared=await prepareMcpConfiguration('test-project',pkg,undefined,noop);let localUrl='';
        const result=await openMcpConfiguration('test-project',pkg,undefined,{...prepared,authorizeSave,open:async url=>{localUrl=url;return true;}},noop);
        const url=new URL(localUrl);const origin=url.origin;const secret=url.hash.slice(1);
        return {prepared,result,url,origin,secret,post:async(route:string,body:unknown,csrf='')=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Configuration-CSRF':csrf},body:JSON.stringify(body)})};
    }
    it('возвращает только метаданные и не записывает параметры в проект',async()=>{
        const pkg=await setup();const before=await fs.readFile(path.join(root,'opencode.json'),'utf8');
        const status=await getMcpConfigurationStatus('test-project',pkg,undefined,noop);
        expect(status).toMatchObject({ready:false,missingFieldIds:['apiKey'],revision:null,assetKind:'mcp'});
        const context=await configurationContext('test-project',pkg,undefined,noop);
        await saveConfiguration(context,{apiKey:'СЕКРЕТ_КОНФИГУРАЦИИ',enabled:false},null,noop);
        const after=await getMcpConfigurationStatus('test-project',pkg,undefined,noop);
        expect(after.ready).toBe(true);expect(after.revision).toMatch(/^[a-f0-9-]{36}$/);
        expect(JSON.stringify(after)).not.toContain('СЕКРЕТ_КОНФИГУРАЦИИ');
        expect(await fs.readFile(path.join(root,'opencode.json'),'utf8')).toBe(before);
        expect(before).not.toContain('TEST_API_KEY');expect(configurationConnection(root,pkg)?.command.at(-1)).toBe(pkg.manifest.sha256);
        const local=await readMcpConfiguration('test-project',pkg,undefined,noop);expect(local.env).toEqual({TEST_API_KEY:'СЕКРЕТ_КОНФИГУРАЦИИ',TEST_ENABLED:'false'});
        expect((await fs.stat(path.join(stateDir(),'local-configuration',context.key+'.json'))).mode&0o777).toBe(0o600);
    });
    it('открывает форму с токеном только во fragment и завершает задание до заполнения',async()=>{
        const pkg=await setup();const session=await opened(pkg);
        expect(session.url.hostname).toBe('127.0.0.1');expect(session.url.search).toBe('');expect(session.secret).toHaveLength(43);
        expect(session.result).toMatchObject({opened:true,preparationId:session.prepared.preparationId});
        expect(JSON.stringify(session.result)).not.toContain(session.secret);expect(JSON.stringify(session.result)).not.toContain('127.0.0.1');
        const page=await fetch(session.origin);expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
        expect(page.headers.get('Access-Control-Allow-Origin')).toBeNull();expect(await page.text()).not.toContain('НЕ_ВЫВОДИТЬ');
        const bootstrap=await session.post('/session',{token:session.secret});expect(bootstrap.status).toBe(200);
        const form=await bootstrap.json() as {csrf:string;revision:null;fields:unknown[]};
        expect(JSON.stringify(form)).not.toContain('TEST_API_KEY');expect((await session.post('/session',{token:session.secret})).status).toBe(403);
        const saved=await session.post('/save',{updates:{apiKey:'ЛОКАЛЬНЫЙ_СЕКРЕТ'},remove:[],expectedRevision:null},form.csrf);
        expect(saved.status).toBe(200);expect(await saved.json()).toEqual({ready:true,missingFieldIds:[]});
        expect((await getMcpConfigurationStatus('test-project',pkg,undefined,noop)).ready).toBe(true);
    });
    it('отклоняет чужой Origin, Host и неправильный CSRF без записи',async()=>{
        const pkg=await setup();const session=await opened(pkg);
        const foreign=await fetch(session.origin+'/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:JSON.stringify({token:session.secret})});expect(foreign.status).toBe(403);
        const hostStatus=await new Promise<number|undefined>((resolve,reject)=>{const outgoing=request(session.origin+'/session',{method:'POST',headers:{Host:'localhost:'+session.url.port,Origin:session.origin,'Content-Type':'application/json'}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});outgoing.once('error',reject);outgoing.end(JSON.stringify({token:session.secret}));});expect(hostStatus).toBe(403);
        await session.post('/session',{token:session.secret});
        const rejected=await session.post('/save',{updates:{apiKey:'НЕ_СОХРАНЯТЬ'},remove:[],expectedRevision:null},'wrong-csrf');expect(rejected.status).toBe(403);
        expect((await getMcpConfigurationStatus('test-project',pkg,undefined,noop)).revision).toBeNull();
    });
    it('два одновременных bootstrap получают только одну сессию',async()=>{
        const pkg=await setup();const session=await opened(pkg);
        const results=await Promise.all([session.post('/session',{token:session.secret}),session.post('/session',{token:session.secret})]);
        expect(results.map(response=>response.status).sort()).toEqual([200,403]);
    });
    it('проверяет свежие права при сохранении после завершения open задания',async()=>{
        const pkg=await setup();const permit=vi.fn(async()=>{throw new Error('доступ отозван');});const session=await opened(pkg,permit);
        const form=await (await session.post('/session',{token:session.secret})).json() as {csrf:string};
        const response=await session.post('/save',{updates:{apiKey:'НЕ_СОХРАНЯТЬ'},remove:[],expectedRevision:null},form.csrf);
        expect(response.status).toBe(400);expect(permit).toHaveBeenCalledOnce();expect((await getMcpConfigurationStatus('test-project',pkg,undefined,noop)).ready).toBe(false);
        expect((await session.post('/save',{updates:{apiKey:'НЕ_СОХРАНЯТЬ'},remove:[],expectedRevision:null},form.csrf)).status).toBe(403);
        expect(permit).toHaveBeenCalledOnce();
    });
    it('изменение файла или физической папки аннулирует открытую форму',async()=>{
        const pkg=await setup();const session=await opened(pkg);const form=await (await session.post('/session',{token:session.secret})).json() as {csrf:string};
        const connection=JSON.parse(await fs.readFile(path.join(root,'opencode.json'),'utf8')) as {mcp:Record<string,{command:string[]}>};
        expect(Object.values(connection.mcp)[0]!.command).toContain(pkg.manifest.sha256);
        const directories=await fs.readdir(path.join(root,'.opencode/mcp-bundles'));await fs.appendFile(path.join(root,'.opencode/mcp-bundles',directories[0]!,'index.mjs'),'\nправка');
        expect((await session.post('/save',{updates:{apiKey:'НЕ_СОХРАНЯТЬ'},remove:[],expectedRevision:null},form.csrf)).status).toBe(400);
    });
    it('не раскрывает сохранённый секрет при повторном открытии',async()=>{
        const pkg=await setup();const context=await configurationContext('test-project',pkg,undefined,noop);await saveConfiguration(context,{apiKey:'ЗАКРЫТЫЙ_КЛЮЧ'},null,noop);
        const session=await opened(pkg);const form=await (await session.post('/session',{token:session.secret})).json() as {csrf:string;revision:string;fields:Array<{configured:boolean}>};
        expect(form.fields[0]?.configured).toBe(true);expect(JSON.stringify(form)).not.toContain('ЗАКРЫТЫЙ_КЛЮЧ');
        expect((await session.post('/save',{updates:{enabled:false},remove:['apiKey'],expectedRevision:form.revision},form.csrf)).status).toBe(200);
        const status=await getMcpConfigurationStatus('test-project',pkg,undefined,noop);expect(status.ready).toBe(false);expect(status.revision).not.toBe(form.revision);
    });
    it('CAS сохраняет только одну конкурентную форму с прежней ревизией',async()=>{
        const pkg=await setup();const context=await configurationContext('test-project',pkg,undefined,noop);
        const results=await Promise.allSettled([saveConfiguration(context,{apiKey:'первый'},null,noop),saveConfiguration(context,{apiKey:'второй'},null,noop)]);
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    });
    it('статус ожидает незавершённую запись и не возвращает прежнюю готовность',async()=>{
        const pkg=await setup();const context=await configurationContext('test-project',pkg,undefined,noop);let release=()=>{};
        const gate=new Promise<void>(resolve=>{release=resolve;});const saving=saveConfiguration(context,{apiKey:'ключ'},null,async()=>gate);
        let completed=false;const reading=getMcpConfigurationStatus('test-project',pkg,undefined,noop).then(result=>{completed=true;return result;});
        await new Promise(resolve=>setTimeout(resolve,30));expect(completed).toBe(false);release();await saving;expect((await reading).ready).toBe(true);
    });
    it('истечение срока непосредственно перед атомарным commit сохраняет прежние параметры',async()=>{
        const pkg=await setup();const context=await configurationContext('test-project',pkg,undefined,noop);await saveConfiguration(context,{apiKey:'прежний'},null,noop);
        const status=await getMcpConfigurationStatus('test-project',pkg,undefined,noop);
        await expect(saveConfiguration(context,{apiKey:'новый'},status.revision,noop,()=>{throw new Error('Сессия истекла.');})).rejects.toThrow('истекла');
        expect((await readMcpConfiguration('test-project',pkg,undefined,noop)).env.TEST_API_KEY).toBe('прежний');
        expect((await getMcpConfigurationStatus('test-project',pkg,undefined,noop)).revision).toBe(status.revision);
    });
    it('схема зависимости MCP настраивается внутри одобренного полного графа',async()=>{
        const member=configuredPackage();const parent=setPackage('parent','skill',1,[member]);const set=setFixture(parent,[member]);await installSet('test-project',set,noop,noop);
        expect((await prepareMcpConfiguration('test-project',member,set,noop)).assetId).toBe(member.plugin.id);
    });
    it('подмена symlink и небезопасные права закрытого файла отклоняются',async()=>{
        const key='a'.repeat(64);await writePrivateConfiguration(key,{secret:'закрыто'},undefined);const file=path.join(stateDir(),'local-configuration',key+'.json');
        await fs.chmod(file,0o644);await expect(readPrivateConfiguration(key)).rejects.toThrow('Небезопасный');await fs.chmod(file,0o600);
        const outside=path.join(temporary,'чужой.json');await fs.rename(file,outside);await fs.symlink(outside,file);
        await expect(readPrivateConfiguration(key)).rejects.toThrow('Небезопасный');expect(await fs.readFile(outside,'utf8')).toContain('закрыто');
    });
    it('невозможность открыть браузер освобождает локальную сессию',async()=>{
        const pkg=await setup();const prepared=await prepareMcpConfiguration('test-project',pkg,undefined,noop);
        await expect(openMcpConfiguration('test-project',pkg,undefined,{...prepared,open:async()=>false},noop)).rejects.toThrow('Не удалось открыть');
    });
    it('установка с необязательными параметрами готовит launcher без открытия мастера и без создания ревизии',async()=>{
        const pkg=configuredPackage();(pkg.config!.extra!.localConfiguration as LocalConfigurationSchema).fields[0]!.required=false;rehashPackage(pkg);await install('test-project',pkg,noop,noop);
        await ensureMcpConfigurationLauncher('test-project',pkg,undefined,noop);
        const descriptor=await readPrivateConfiguration<LauncherDescriptor>(await launcherDescriptorKey('test-project',assetKey(pkg),pkg.manifest.sha256));
        expect(descriptor?.pkg.manifest.sha256).toBe(pkg.manifest.sha256);
        expect(await getMcpConfigurationStatus('test-project',pkg,undefined,noop)).toMatchObject({ready:true,revision:null,missingFieldIds:[]});
    });
    it('инертный дескриптор готовится до установки и новая версия не заменяет старый',async()=>{
        const pkg=configuredPackage();await prepareMcpConfigurationLauncher('test-project',pkg,undefined,noop);
        const oldKey=await launcherDescriptorKey('test-project',assetKey(pkg),pkg.manifest.sha256);const before=await readPrivateConfiguration(oldKey);
        const next=structuredClone(pkg);next.plugin.version=2;rehashPackage(next);await prepareMcpConfigurationLauncher('test-project',next,undefined,noop);
        expect(await readPrivateConfiguration(oldKey)).toEqual(before);
        expect(await launcherDescriptorKey('test-project',assetKey(next),next.manifest.sha256)).not.toBe(oldKey);
        await expect(getMcpConfigurationStatus('test-project',pkg,undefined,noop)).rejects.toThrow();
    });
    it('дескриптор с разрешёнными файлами больше 1 МиБ помещается в отдельный metadata-бюджет',async()=>{
        const pkg=configuredPackage();pkg.files=Array.from({length:2},(_,index)=>{const content='x'.repeat(700*1024);return {path:index?'resource.txt':'index.mjs',content,size:Buffer.byteLength(content),sha256:hash(content)};});rehashPackage(pkg);
        await prepareMcpConfigurationLauncher('test-project',pkg,undefined,noop);
        const key=await launcherDescriptorKey('test-project',assetKey(pkg),pkg.manifest.sha256);expect((await fs.stat(path.join(stateDir(),'local-configuration',key+'.json'))).size).toBeGreaterThan(1024*1024);
        expect((await readPrivateConfiguration<LauncherDescriptor>(key))?.pkg.manifest.sha256).toBe(pkg.manifest.sha256);
    });
    it('общий приватный бюджет 1 ГиБ отклоняет новую запись без изменения существующей',async()=>{
        const key='b'.repeat(64);await writePrivateConfiguration(key,{test:true},undefined);
        const existing=path.join(stateDir(),'local-configuration',key+'.json');await fs.truncate(existing,1024*1024*1024);
        await expect(writePrivateConfiguration('c'.repeat(64),{test:true},undefined)).rejects.toThrow('бюджет');
        expect((await fs.stat(existing)).size).toBe(1024*1024*1024);
    });
    it('истёкшая подготовка отклоняется до открытия браузера',async()=>{
        const pkg=await setup();const prepared=await prepareMcpConfiguration('test-project',pkg,undefined,noop);vi.useFakeTimers();vi.setSystemTime(Date.now()+16*60_000);
        try{await expect(openMcpConfiguration('test-project',pkg,undefined,{...prepared,open:async()=>true},noop)).rejects.toThrow('устарела');}finally{vi.useRealTimers();}
    });
});

describe('Декларативная схема параметров',()=>{
    it.each(['PATH','NODE_OPTIONS','LD_PRELOAD','__proto__','constructor','prototype','Constructor'])('отклоняет опасное назначение %s',name=>{
        const pkg=configuredPackage();(pkg.config!.extra!.localConfiguration as LocalConfigurationSchema).fields[0]!.target.name=name;
        expect(()=>parseLocalConfiguration(pkg)).toThrow();
    });
    it('отклоняет повтор id и назначения, а также схемы скиллов',()=>{
        const pkg=configuredPackage();const local=pkg.config!.extra!.localConfiguration as LocalConfigurationSchema;
        local.fields.push({...local.fields[0]!});expect(()=>parseLocalConfiguration(pkg)).toThrow();
        pkg.plugin.kind='skill';expect(()=>parseLocalConfiguration(pkg)).toThrow();
    });
    it('для удалённого MCP принимает заголовки и отклоняет неиспользуемое окружение',()=>{
        const pkg=configuredPackage();pkg.config!.transport='remote';expect(()=>parseLocalConfiguration(pkg)).toThrow();
        const local=pkg.config!.extra!.localConfiguration as LocalConfigurationSchema;local.fields=[{...local.fields[0]!,target:{kind:'header',name:'Authorization',prefix:'Bearer '}}];
        expect(parseLocalConfiguration(pkg)?.fields[0]?.target.kind).toBe('header');local.fields[0]!.target.name='Host';expect(()=>parseLocalConfiguration(pkg)).toThrow();
    });
    it('проверяет типы без приведения, ограничивает длину и не допускает CRLF',()=>{
        expect(()=>validateConfigurationValues(schema,{enabled:'false'})).toThrow();expect(()=>validateConfigurationValues(schema,{apiKey:'a\r\nb'})).toThrow();
        expect(()=>validateConfigurationValues(schema,{apiKey:'a'.repeat(8193)})).toThrow();expect(()=>validateConfigurationValues(schema,{unknown:'x'})).toThrow();
        expect(validateConfigurationValues(schema,{apiKey:'',enabled:false})).toEqual({enabled:false});
    });
    it('параметры не получают увеличенный лимит metadata: суммарно больше 64 КиБ запрещено',()=>{
        const fields=Array.from({length:9},(_,index)=>({...schema.fields[0]!,id:'key'+index,target:{kind:'env' as const,name:'KEY_'+index}}));
        expect(()=>validateConfigurationValues({schemaVersion:1,fields},Object.fromEntries(fields.map(field=>[field.id,'x'.repeat(8192)])))).toThrow('Некорректные значения');
    });
    it('хэш схемы каноничен и изменяется при изменении назначения',()=>{
        const swapped={fields:schema.fields,schemaVersion:1} as LocalConfigurationSchema;expect(localConfigurationDigest(swapped)).toBe(localConfigurationDigest(schema));
        const changed=structuredClone(schema);changed.fields[0]!.target.name='OTHER';expect(localConfigurationDigest(changed)).not.toBe(localConfigurationDigest(schema));
    });
});
