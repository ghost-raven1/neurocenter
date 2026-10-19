import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {workspaceFixture} from './bridge-fixture.js';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash,hub,writeState} from '../src/bridge/state.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {runtimeArtifactTarget} from '../src/features/runtime-artifacts/model.js';
import {ensureRuntimeArtifact} from '../src/features/runtime-artifacts/cache.js';
import {install} from '../src/bridge/installer.js';
import {probeInstalledRagMcp} from '../src/features/rag-ui/mcp-startup.js';
import {probeMcp} from '../src/features/runtime-probe/mcp.js';
import {configurationContext} from '../src/features/local-configuration/context.js';
import {saveConfiguration} from '../src/features/local-configuration/state.js';
import {getMcpConfigurationStatus,readMcpConfiguration,prepareMcpConfigurationLauncher} from '../src/features/local-configuration/index.js';
import {localIndexProfile} from '../src/features/rag-index/readiness.js';
import {locateStore} from '../src/lib/store.js';
import {assetKey,receiptPath} from '../src/bridge/installation-receipt.js';
import {openRagUi,closeRagUis} from '../src/features/rag-ui/index.js';
import {startRagUiProcess} from '../src/features/rag-ui/process.js';
import {openRagBrowserWindow} from '../src/features/rag-ui/browser-window.js';
vi.mock('../src/features/runtime-probe/mcp.js',()=>({probeMcp:vi.fn()}));
vi.mock('../src/features/rag-ui/process.js',()=>({startRagUiProcess:vi.fn()}));
vi.mock('../src/features/rag-ui/browser-window.js',()=>({openRagBrowserWindow:vi.fn()}));
import {managedRagMcpEmbedding} from '../src/features/rag-ui/managed-installation.js';
import {profileKey} from '../src/features/rag-hosted/profile.js';
import {writePrivateConfiguration} from '../src/features/local-configuration/private-store.js';
import {setPackage,rehashPackage} from './install-set-fixture.js';
const noop=async()=>{};
describe('Установленный RAG MCP запускается без ручной настройки и сохраняет явные параметры',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>,pkg:Package,binding:string;
    function rehash(){pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]})));}
    beforeEach(async()=>{
        vi.clearAllMocks();fixture=await workspaceFixture();await writeState('credentials',{deviceId:'11111111-1111-4111-8111-111111111111',token:'fixture',email:'fixture@example.test'});
        const {archive,descriptor}=artifactFixture([{path:'opencode-rag.mjs',content:'export default {};'}],runtimeArtifactTarget());
        pkg={schemaVersion:5,plugin:{id:'rag-config-test',name:'rag',kind:'mcp',version:1},config:{command:'node',entrypoint:'opencode-rag.mjs',args:['mcp'],extra:{runtimeArtifacts:[descriptor],
            localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']},localConfiguration:{schemaVersion:1,fields:[
                {id:'embeddingUrl',label:'URL',type:'url',required:true,target:{kind:'env',name:'NEUROCENTER_RAG_EMBEDDING_URL'}},
                {id:'embeddingModel',label:'Модель',type:'string',required:true,target:{kind:'env',name:'NEUROCENTER_RAG_EMBEDDING_MODEL'}},
                {id:'embeddingKey',label:'Ключ',type:'string',required:false,secret:true,target:{kind:'env',name:'NEUROCENTER_RAG_EMBEDDING_KEY'}}]}}},files:[],manifest:{sha256:'',filesCount:0}};
        rehash();await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([archive])});await prepareMcpConfigurationLauncher('test-project',pkg,undefined,noop);await install('test-project',pkg,noop,noop);binding=await projectBindingId('test-project');
        vi.mocked(probeMcp).mockResolvedValue({tools:3,resources:0,prompts:0});
    });
    afterEach(async()=>{await closeRagUis();vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
    it('Готовность конкретного MCP не заимствует hosted-профиль соседнего плагина',async()=>{
        pkg.plugin.version++;pkg.config!.extra!.hostedEmbedding={schemaVersion:1,profileSchemaVersion:2};rehash();await prepareMcpConfigurationLauncher('test-project',pkg,undefined,noop);await install('test-project',pkg,noop,noop);
        const other=setPackage('hosted-neighbor','plugin');other.schemaVersion=5;other.config!.extra={hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2}};rehashPackage(other);await install('test-project',other,noop,noop);
        const instance=await projectInstanceId('test-project'),pin='a'.repeat(64),own={revision:1,modelPin:pin,profile:{provider:'openai',model:'neurocenter/own/sha256/'+pin,dimension:3}},neighbor={revision:2,modelPin:'b'.repeat(64),profile:{provider:'openai',model:'neurocenter/other/sha256/'+'b'.repeat(64),dimension:3}};
        await writePrivateConfiguration(profileKey(hub(),fixture.root,instance),{schemaVersion:2,server:hub(),root:fixture.root,projectId:'test-project',bindingId:binding,instanceId:instance,relay:{port:34567},grants:[{pkg,selection:own,key:'c'.repeat(64)},{pkg:other,selection:neighbor,key:'d'.repeat(64)}]},undefined);
        const receipt=JSON.parse(await fs.readFile(fixture.root+'/'+receiptPath(pkg),'utf8'));
        expect((await managedRagMcpEmbedding(fixture.root,'test-project',assetKey(pkg),receipt))?.model).toBe(own.profile.model);
    });
    it('Initialize/list не требует модели и оставляет defaults только в памяти CLI',async()=>{
        const before=await fs.readFile(fixture.root+'/opencode.json','utf8');
        await expect(probeInstalledRagMcp('test-project',binding,pkg,noop)).resolves.toEqual({tools:3,resources:0,prompts:0});
        const profile=vi.mocked(probeMcp).mock.calls[0]![1];expect(profile.env.NEUROCENTER_RAG_EMBEDDING_URL).toBeUndefined();
        const scope=vi.mocked(probeMcp).mock.calls[0]![2];expect(scope.deadline-Date.now()).toBeLessThanOrEqual(12000);
        expect(await getMcpConfigurationStatus('test-project',pkg,undefined,noop)).toMatchObject({ready:true,missingFieldIds:[],revision:null});
        expect(await fs.readFile(fixture.root+'/opencode.json','utf8')).toBe(before);await expect(fs.stat(fixture.root+'/opencode-rag.json')).rejects.toHaveProperty('code','ENOENT');
    });
    it('Обновление пакета сохраняет прежние URL, модель и ключ при неизменной схеме',async()=>{
        const context=await configurationContext('test-project',pkg,undefined,noop);
        await saveConfiguration(context,{embeddingUrl:'https://private.test/v1',embeddingModel:'explicit',embeddingKey:'PRIVATE_KEY'},null,noop);
        pkg.plugin.version=2;rehash();await prepareMcpConfigurationLauncher('test-project',pkg,undefined,noop);await install('test-project',pkg,noop,noop);
        const current=await readMcpConfiguration('test-project',pkg,undefined,noop);
        expect(current.env).toEqual({NEUROCENTER_RAG_EMBEDDING_URL:'https://private.test/v1',NEUROCENTER_RAG_EMBEDDING_MODEL:'explicit',NEUROCENTER_RAG_EMBEDDING_KEY:'PRIVATE_KEY'});
        await probeInstalledRagMcp('test-project',binding,pkg,noop);expect(vi.mocked(probeMcp).mock.calls[0]![1].env.NEUROCENTER_RAG_EMBEDDING_KEY).toBe('PRIVATE_KEY');
        expect(await localIndexProfile(await locateStore(fixture.root,fixture.root),3)).toEqual({provider:'ollama',model:'explicit',dimension:3});
    });
    it('Сбой stdio и отсутствие инструментов не меняют установленную квитанцию',async()=>{
        const before=await fs.readFile(fixture.root+'/opencode.json','utf8');vi.mocked(probeMcp).mockRejectedValueOnce(new Error('private diagnostic'));
        await expect(probeInstalledRagMcp('test-project',binding,pkg,noop)).rejects.toThrow();
        vi.mocked(probeMcp).mockResolvedValueOnce({tools:0,resources:0,prompts:0});await expect(probeInstalledRagMcp('test-project',binding,pkg,noop)).rejects.toThrow('инструменты');
        expect(await fs.readFile(fixture.root+'/opencode.json','utf8')).toBe(before);
    });
    it('MCP-only установка доказывает default-профиль без projectconfig и без угадывания по размерности',async()=>{
        expect(await localIndexProfile(await locateStore(fixture.root,fixture.root),2560)).toEqual({provider:'ollama',model:'qwen3-embedding:4b',dimension:2560});
        await expect(localIndexProfile(await locateStore(fixture.root,fixture.root),3)).rejects.toThrow('размерность');
        await expect(fs.stat(fixture.root+'/opencode-rag.json')).rejects.toHaveProperty('code','ENOENT');
    });
    it('Новая private-ревизия перезапускает UI с текущей настройкой, не включая секрет в результат',async()=>{
        const stops:Array<ReturnType<typeof vi.fn>>=[];
        vi.mocked(startRagUiProcess).mockImplementation(async()=>{
            const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});const stop=vi.fn(async()=>{child.emit('close');});stops.push(stop);
            return {child:child as never,url:'http://127.0.0.1:49152/#neurocenter-token='+'a'.repeat(48),stop};
        });vi.mocked(openRagBrowserWindow).mockResolvedValue();
        const input={projectId:'test-project',bindingId:binding,instanceId:await projectInstanceId('test-project'),pkg};
        await openRagUi(input,noop);
        const context=await configurationContext('test-project',pkg,undefined,noop);
        await saveConfiguration(context,{embeddingUrl:'https://private.test/v1',embeddingModel:'new-model',embeddingKey:'PRIVATE_KEY'},null,noop);
        const result=await openRagUi(input,noop);
        expect(startRagUiProcess).toHaveBeenCalledTimes(2);expect(stops[0]).toHaveBeenCalledWith({force:false,timeoutMs:5000});
        expect(vi.mocked(startRagUiProcess).mock.calls[1]![3].NEUROCENTER_RAG_EMBEDDING_KEY).toBe('PRIVATE_KEY');
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_KEY|private\.test|127\.0\.0\.1/);
    });
    it.each(['receipt','configuration','old-descriptor'])('Чужое или устаревшее доказательство %s не включает default-профиль',async kind=>{
        if(kind==='receipt'){
            const file=fixture.root+'/'+receiptPath(pkg),receipt=JSON.parse(await fs.readFile(file,'utf8'));receipt.manifest='f'.repeat(64);await fs.writeFile(file,JSON.stringify(receipt));
        }else if(kind==='configuration')await fs.writeFile(fixture.root+'/opencode.json','{}');
        else{
            const previous=structuredClone(pkg);delete previous.config!.extra!.localUi;pkg=previous;rehash();await prepareMcpConfigurationLauncher('test-project',pkg,undefined,noop);await install('test-project',pkg,noop,noop);
        }
        await expect(localIndexProfile(await locateStore(fixture.root,fixture.root),2560)).rejects.toThrow('не подтверждён');
    });
});
