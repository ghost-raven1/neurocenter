import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {workspaceFixture} from './bridge-fixture.js';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash} from '../src/bridge/state.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import * as workspace from '../src/bridge/workspace.js';
import {runtimeArtifactTarget} from '../src/features/runtime-artifacts/model.js';
import {ensureRuntimeArtifact} from '../src/features/runtime-artifacts/cache.js';
import {install} from '../src/bridge/installer.js';
import {openRagUi,closeRagUis,closeOwnRagUi,RAG_UI_NOTE} from '../src/features/rag-ui/index.js';
import {startRagUiProcess} from '../src/features/rag-ui/process.js';
import {openRagBrowserWindow} from '../src/features/rag-ui/browser-window.js';
vi.mock('../src/features/rag-ui/process.js',()=>({startRagUiProcess:vi.fn()}));
vi.mock('../src/features/rag-ui/browser-window.js',()=>({openRagBrowserWindow:vi.fn()}));
const url='http://127.0.0.1:49152/#neurocenter-token='+'a'.repeat(48);
describe('Открытие RAG UI не выполняет произвольные команды и сохраняет границы экземпляра',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>,pkg:Package,input:Parameters<typeof openRagUi>[0];
    let stop:ReturnType<typeof vi.fn>,child:EventEmitter&{exitCode:null;signalCode:null};
    beforeEach(async()=>{
        vi.clearAllMocks();fixture=await workspaceFixture();
        const {archive,descriptor}=artifactFixture([{path:'opencode-rag.mjs',content:'export default {};'}],runtimeArtifactTarget());
        pkg={schemaVersion:5,plugin:{id:'test-rag',name:'rag',kind:'mcp',version:1},config:{command:'node',entrypoint:'opencode-rag.mjs',args:['mcp'],extra:{runtimeArtifacts:[descriptor],
            localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']}}},files:[],manifest:{sha256:'',filesCount:0}};
        pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]})));
        await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([archive])});await install('test-project',pkg,async()=>{},async()=>{});
        child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});stop=vi.fn(async()=>{child.emit('close');});
        vi.mocked(startRagUiProcess).mockResolvedValue({child:child as never,url,stop});vi.mocked(openRagBrowserWindow).mockResolvedValue();
        input={projectId:'test-project',bindingId:await projectBindingId('test-project'),instanceId:await projectInstanceId('test-project'),pkg};
    });
    afterEach(async()=>{await closeRagUis();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
    it('Возвращает только факт готовности и повторно использует свой сервер',async()=>{
        const authorize=vi.fn(async()=>{});
        expect(await openRagUi(input,authorize)).toEqual({opened:true,reused:false,note:RAG_UI_NOTE});
        expect(await openRagUi(input,authorize)).toEqual({opened:true,reused:true,note:RAG_UI_NOTE});
        expect(startRagUiProcess).toHaveBeenCalledOnce();expect(openRagBrowserWindow).toHaveBeenCalledTimes(2);expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(6);
        expect(JSON.stringify(await openRagUi(input,authorize))).not.toMatch(/127\.0\.0\.1|49152|neurocenter-token|\/Users\//);
    });
    it('Ошибка открытия нового окна закрывает только новый сервер',async()=>{
        vi.mocked(openRagBrowserWindow).mockRejectedValueOnce(new Error('браузер недоступен'));
        await expect(openRagUi(input,async()=>{})).rejects.toThrow('браузер недоступен');expect(stop).toHaveBeenCalledOnce();
        await openRagUi(input,async()=>{});expect(startRagUiProcess).toHaveBeenCalledTimes(2);
    });
    it('Ошибка повторного окна сохраняет работающий управляемый UI',async()=>{
        await openRagUi(input,async()=>{});vi.mocked(openRagBrowserWindow).mockRejectedValueOnce(new Error('браузер недоступен'));
        await expect(openRagUi(input,async()=>{})).rejects.toThrow();expect(stop).not.toHaveBeenCalled();
    });
    it('Перед восстановлением закрывается только собственный сервер текущего проекта без force kill',async()=>{
        await openRagUi(input,async()=>{});await closeOwnRagUi('another-project');expect(stop).not.toHaveBeenCalled();
        await closeOwnRagUi(input.projectId);expect(stop).toHaveBeenCalledWith({force:false,timeoutMs:120000});
        await openRagUi(input,async()=>{});expect(startRagUiProcess).toHaveBeenCalledTimes(2);
    });
    it('Новая привязка не получает старый процесс или окно',async()=>{
        await expect(openRagUi({...input,bindingId:'f'.repeat(64)},async()=>{})).rejects.toThrow('изменилась');expect(startRagUiProcess).not.toHaveBeenCalled();
    });
    it('Ручная правка config блокирует запуск до выполнения кода',async()=>{
        await fs.writeFile(fixture.root+'/opencode.json','{}');await expect(openRagUi(input,async()=>{})).rejects.toThrow('Файлы установки');expect(startRagUiProcess).not.toHaveBeenCalled();
    });
    it('Остановка worker завершает только его UI, а изменение папки закрывает открытую сессию',async()=>{
        await openRagUi(input,async()=>{});await closeRagUis();expect(stop).toHaveBeenCalledOnce();
        vi.useFakeTimers();await openRagUi(input,async()=>{});vi.spyOn(workspace,'projectBindingId').mockResolvedValue('e'.repeat(64));
        await vi.advanceTimersByTimeAsync(15001);
        expect(stop).toHaveBeenCalledTimes(2);await expect(openRagUi(input,async()=>{})).rejects.toThrow('изменилась');
    });
});
