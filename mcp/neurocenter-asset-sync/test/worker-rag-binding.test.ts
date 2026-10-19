import fs from 'node:fs/promises';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as state from '../src/bridge/state.js';
import * as workspace from '../src/bridge/workspace.js';
import {runWorker} from '../src/bridge/worker.js';
import {runRagBridgeJob} from '../src/bridge/rag-worker.js';
import {workspaceFixture} from './bridge-fixture.js';

const socket=vi.hoisted(()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}));
vi.mock('socket.io-client',()=>({io:vi.fn(()=>socket)}));
vi.mock('../src/bridge/state.js',async original=>({...await original<typeof import('../src/bridge/state.js')>(),api:vi.fn()}));
vi.mock('../src/bridge/rag-worker.js',()=>({runRagBridgeJob:vi.fn()}));

describe('Worker не переносит задание знаний на другую привязку папки',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>;
    let signals:Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>;
    let bindingId:string;
    const id='11111111-1111-1111-1111-111111111111';
    beforeEach(async()=>{
        fixture=await workspaceFixture();vi.clearAllMocks();
        signals=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
        await state.writeState('credentials',{token:'fixture',deviceId:'33333333-3333-3333-3333-333333333333',email:'fixture@example.test'});
        bindingId=await workspace.projectBindingId('test-project');
        vi.spyOn(workspace,'workspaceReport').mockResolvedValue({} as never);
        vi.spyOn(process.stderr,'write').mockReturnValue(true);vi.spyOn(process,'exit').mockImplementation((()=>undefined) as never);
        socket.disconnect.mockReturnValue(socket);socket.connect.mockReturnValue(socket);
    });
    afterEach(async()=>{
        const stop=process.listeners('SIGTERM').find(listener=>!signals.get('SIGTERM')!.has(listener));stop?.();
        if(stop) await vi.waitFor(()=>expect(process.exit).toHaveBeenCalled());
        for(const [signal,previous] of signals) for(const listener of process.listeners(signal)) if(!previous.has(listener)) process.off(signal,listener);
        vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});
    });
    function queue(kind:'sync-rag'|'restore-rag',binding:string|undefined) {
        let claimed=false;
        vi.mocked(state.api).mockImplementation(async route=>{
            if(route==='jobs/claim') {
                if(claimed) return null as never;claimed=true;
                return {id,lease:'22222222-2222-2222-2222-222222222222',kind,project_id:'test-project',payload:{bindingId:binding}} as never;
            }
            return {} as never;
        });
    }
    it.each(['sync-rag','restore-rag'] as const)('%s отклоняется до чтения индекса, если папка уже изменилась',async kind=>{
        queue(kind,'c'.repeat(64));await runWorker();
        expect(runRagBridgeJob).not.toHaveBeenCalled();
        expect(vi.mocked(state.api).mock.calls.find(([route])=>route===`jobs/${id}/complete`)?.[1]).toMatchObject({state:'failed',result:{}});
    });
    it('Callback перед локальным commit повторно проверяет исходную привязку',async()=>{
        queue('restore-rag',bindingId);
        vi.mocked(runRagBridgeJob).mockImplementation(async(_job,authorize)=>{
            vi.spyOn(workspace,'projectBindingId').mockResolvedValue('d'.repeat(64));
            await authorize();return {};
        });
        await runWorker();
        expect(runRagBridgeJob).toHaveBeenCalledOnce();
        expect(vi.mocked(state.api).mock.calls.find(([route])=>route===`jobs/${id}/complete`)?.[1]).toMatchObject({state:'failed',result:{}});
    });
    it.each(['Закройте OpenCode перед восстановлением.','Профиль модели не совпадает с локальным индексом.'])('Причина блокировки RAG видна пользователю: %s',async message=>{
        queue('restore-rag',bindingId);vi.mocked(runRagBridgeJob).mockRejectedValue(new Error(message));
        await runWorker();
        expect(vi.mocked(state.api).mock.calls.find(([route])=>route===`jobs/${id}/complete`)?.[1]).toMatchObject({state:'failed',message,result:{}});
    });
});
