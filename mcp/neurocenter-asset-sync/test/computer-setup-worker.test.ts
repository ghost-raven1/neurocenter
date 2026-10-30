import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {io} from 'socket.io-client';
import * as state from '../src/bridge/state.js';
import {runWorker} from '../src/bridge/worker.js';
import {runComputerSetupJob,recoverComputerSetupJobs,stopComputerSetupJobs} from '../src/features/computer-setup/executor.js';
import {startRoleMcpPoller} from '../src/features/system-role-mcp/poller.js';
import {CliCleanupError} from '../src/features/computer-setup/receipts.js';
import {workspaceFixture} from './bridge-fixture.js';

const socket=vi.hoisted(()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}));
vi.mock('socket.io-client',()=>({io:vi.fn(()=>socket)}));
vi.mock('../src/bridge/state.js',async original=>({...await original<typeof import('../src/bridge/state.js')>(),api:vi.fn()}));
vi.mock('../src/features/computer-setup/executor.js',()=>({runComputerSetupJob:vi.fn(),recoverComputerSetupJobs:vi.fn(),stopComputerSetupJobs:vi.fn()}));
// The global provider owner independently verifies nested compatibility recovery in its own causal suite.
vi.mock('../src/features/opencode-local-providers/index.js',()=>({runGlobalProvidersJob:vi.fn(),recoverGlobalProvidersJobs:vi.fn(async()=>{}),stopGlobalProvidersJobs:vi.fn(async()=>{})}));
vi.mock('../src/features/system-role-mcp/poller.js',()=>({startRoleMcpPoller:vi.fn(()=>({wake:vi.fn(),stop:vi.fn(async()=>{}),active:0}))}));
vi.mock('../src/bridge/opencode-model-sync.js',()=>({synchronizeOpenCodeModels:async()=>{}}));
vi.mock('../src/features/project-learning/observation-sync.js',()=>({synchronizeLearningObservations:async()=>{}}));
vi.mock('../src/features/runtime-artifacts/update-cleanup.js',async original=>({...await original<typeof import('../src/features/runtime-artifacts/update-cleanup.js')>(),cleanupInstalledBridge:async()=>undefined}));

describe('CLI cleanup gates both actual worker dispatch lanes',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>,previous:Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>,worker:Promise<void>|undefined;
    let exitCode:typeof process.exitCode,terminated:boolean;
    const deviceId='22222222-2222-4222-8222-222222222222';
    beforeEach(async()=>{
        vi.clearAllMocks();terminated=false;worker=undefined;exitCode=process.exitCode;
        previous=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
        fixture=await workspaceFixture();await state.writeState('credentials',{token:'owned-cli-fixture',deviceId,email:'fixture@example.test'});
        socket.disconnect.mockReturnValue(socket);socket.connect.mockReturnValue(socket);
        vi.spyOn(process,'exit').mockImplementation((()=>undefined)as never);vi.spyOn(process.stderr,'write').mockReturnValue(true);
        vi.mocked(recoverComputerSetupJobs).mockResolvedValue();vi.mocked(stopComputerSetupJobs).mockResolvedValue();
        vi.mocked(state.api).mockImplementation(async route=>(route==='jobs/claim'?null:{})as never);
    });
    function terminate(){terminated=true;const listener=process.listeners('SIGTERM').find(value=>!previous.get('SIGTERM')!.has(value));listener?.();}
    function wake(){const handler=socket.on.mock.calls.find(([event])=>event==='bridge:work')?.[1];expect(handler).toBeTypeOf('function');handler();}
    afterEach(async()=>{
        try{
            await worker?.catch(()=>{});
            if(!terminated){terminate();if(process.listeners('SIGTERM').some(value=>!previous.get('SIGTERM')!.has(value)))await vi.waitFor(()=>expect(process.exit).toHaveBeenCalledWith(0));}
        }finally{
            for(const[signal,listeners]of previous)for(const listener of process.listeners(signal))if(!listeners.has(listener))process.off(signal,listener);
            process.exitCode=exitCode;vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});
        }
    });
    const claims=()=>vi.mocked(state.api).mock.calls.filter(([route])=>route==='jobs/claim').length;
    it('refuses startup before socket, normal claim or MCP poller when orphan cleanup is uncertain',async()=>{
        vi.mocked(recoverComputerSetupJobs).mockRejectedValue(new CliCleanupError(new Error('private unknown closure')));
        worker=runWorker();await expect(worker).rejects.toBeInstanceOf(CliCleanupError);
        expect(io).not.toHaveBeenCalled();expect(startRoleMcpPoller).not.toHaveBeenCalled();expect(claims()).toBe(0);
        expect(await fs.readFile(path.join(state.stateDir(),'worker.lock'),'utf8')).toBe(String(process.pid));
    });
    it('starts exactly one MCP poller after successful recovery and handles repeated wakes with the same poller',async()=>{
        vi.mocked(recoverComputerSetupJobs).mockResolvedValueOnce().mockRejectedValueOnce(new CliCleanupError(new Error('private transient uncertainty'))).mockResolvedValue();
        worker=runWorker();await worker;expect(startRoleMcpPoller).not.toHaveBeenCalled();expect(claims()).toBe(0);
        wake();await vi.waitFor(()=>expect(claims()).toBe(1));expect(startRoleMcpPoller).toHaveBeenCalledOnce();
        wake();await vi.waitFor(()=>expect(claims()).toBe(2));expect(startRoleMcpPoller).toHaveBeenCalledOnce();
    });
    it('stops the current poller and refuses both lanes until CLI cleanup subsequently succeeds',async()=>{
        let accepted=false;
        vi.mocked(state.api).mockImplementation(async route=>{
            if(route==='jobs/claim'){if(accepted)return null as never;accepted=true;return{id:'11111111-1111-4111-8111-111111111111',lease:'33333333-3333-4333-8333-333333333333',kind:'inspect-opencode-cli',payload:{schemaVersion:1,scope:'global',deviceId}}as never;}
            return{}as never;
        });
        vi.mocked(runComputerSetupJob).mockRejectedValue(new CliCleanupError(new Error('private closure uncertainty')));
        worker=runWorker();await worker;
        const first=vi.mocked(startRoleMcpPoller).mock.results[0]!.value;expect(first.stop).toHaveBeenCalledOnce();expect(claims()).toBe(1);
        expect(vi.mocked(state.api).mock.calls.some(([route])=>route.endsWith('/complete'))).toBe(false);
        vi.mocked(recoverComputerSetupJobs).mockRejectedValue(new CliCleanupError(new Error('still uncertain')));wake();
        await vi.waitFor(()=>expect(recoverComputerSetupJobs).toHaveBeenCalledTimes(3));expect(startRoleMcpPoller).toHaveBeenCalledOnce();expect(claims()).toBe(1);
        vi.mocked(recoverComputerSetupJobs).mockResolvedValue();wake();await vi.waitFor(()=>expect(claims()).toBe(2));
        expect(startRoleMcpPoller).toHaveBeenCalledTimes(2);expect(first.stop).toHaveBeenCalledOnce();
    });
    it('does not exit successfully or release the worker lock after rejected owned cleanup',async()=>{
        worker=runWorker();await worker;
        vi.mocked(stopComputerSetupJobs).mockRejectedValue(new CliCleanupError(new Error('private unresolved owner')));terminate();
        await vi.waitFor(()=>expect(process.exitCode).toBe(1));expect(process.exit).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(state.stateDir(),'worker.lock'),'utf8')).toBe(String(process.pid));
    });
});
