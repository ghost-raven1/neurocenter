import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as state from '../src/bridge/state.js';
import {runWorker} from '../src/bridge/worker.js';
import {startRoleMcpPoller} from '../src/features/system-role-mcp/poller.js';
import {recoverComputerSetupJobs,stopComputerSetupJobs} from '../src/features/computer-setup/executor.js';
import {install} from '../src/bridge/installer.js';
import {workspaceFixture,packageFixture} from './bridge-fixture.js';
import {projectBindingId} from '../src/bridge/workspace.js';
import * as workspace from '../src/bridge/workspace.js';
import {stopFixtureWorker} from './worker-lifecycle.fixture.js';

const socket=vi.hoisted(()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}));
vi.mock('socket.io-client',()=>({io:vi.fn(()=>socket)}));
vi.mock('../src/bridge/state.js',async original=>({...await original<typeof import('../src/bridge/state.js')>(),api:vi.fn()}));
vi.mock('../src/features/system-role-mcp/poller.js',()=>({startRoleMcpPoller:vi.fn(()=>({wake:vi.fn(),stop:vi.fn(async()=>{}),active:0}))}));
vi.mock('../src/features/computer-setup/executor.js',()=>({runComputerSetupJob:vi.fn(),recoverComputerSetupJobs:vi.fn(),stopComputerSetupJobs:vi.fn()}));
vi.mock('../src/bridge/installer.js',async original=>({...await original<typeof import('../src/bridge/installer.js')>(),install:vi.fn()}));
vi.mock('../src/bridge/job-runtime-artifacts.js',()=>({prepareJobRuntimeArtifacts:async()=>{}}));
vi.mock('../src/bridge/opencode-model-sync.js',()=>({synchronizeOpenCodeModels:async()=>{}}));
vi.mock('../src/features/project-learning/observation-sync.js',()=>({synchronizeLearningObservations:async()=>{}}));
vi.mock('../src/features/runtime-artifacts/update-cleanup.js',async original=>({...await original<typeof import('../src/features/runtime-artifacts/update-cleanup.js')>(),cleanupInstalledBridge:async()=>undefined}));

describe('Presence survives a damaged local workspace without admitting work',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>,previous:Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>,worker:Promise<void>|undefined;
    let baseline:string;
    beforeEach(async()=>{
        vi.clearAllMocks();worker=undefined;
        previous=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
        fixture=await workspaceFixture();baseline=await fs.readFile(path.join(state.stateDir(),'workspace.json'),'utf8');
        await state.writeState('credentials',{token:'owned-presence-fixture',deviceId:'22222222-2222-4222-8222-222222222222',email:'fixture@example.test'});
        socket.disconnect.mockReturnValue(socket);socket.connect.mockReturnValue(socket);
        vi.spyOn(process,'exit').mockImplementation((()=>undefined)as never);vi.spyOn(process.stderr,'write').mockReturnValue(true);
        vi.mocked(state.api).mockImplementation(async route=>(route==='jobs/claim'?null:{})as never);
        vi.mocked(recoverComputerSetupJobs).mockResolvedValue();vi.mocked(stopComputerSetupJobs).mockResolvedValue();
        vi.useFakeTimers();
    });
    afterEach(async()=>{
        try{await worker;await stopFixtureWorker(previous);}
        finally{
            vi.clearAllTimers();vi.useRealTimers();
            for(const[signal,listeners]of previous)for(const listener of process.listeners(signal))if(!listeners.has(listener))process.off(signal,listener);
            vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});
        }
    });
    const calls=(route:string)=>vi.mocked(state.api).mock.calls.filter(([value])=>value===route);
    it.each(['{',JSON.stringify({bindings:{'test-project':17}})])('publishes runtime identity, retains corrupt bytes and blocks both claim lanes: %s',async damaged=>{
        await fs.writeFile(path.join(state.stateDir(),'workspace.json'),damaged);
        worker=runWorker();await worker;await vi.advanceTimersByTimeAsync(15_000);
        await vi.waitFor(()=>expect(calls('presence').length).toBeGreaterThan(0));
        const presence=calls('presence');
        expect(presence.at(-1)?.[1]).toMatchObject({bridgeVersion:expect.any(String),buildId:expect.any(String),protocolVersion:2});
        expect(presence.at(-1)?.[1]).not.toHaveProperty('bindings');expect(presence.at(-1)?.[1]).not.toHaveProperty('folders');
        expect(calls('heartbeat')).toHaveLength(0);expect(calls('jobs/claim')).toHaveLength(0);expect(startRoleMcpPoller).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(state.stateDir(),'workspace.json'),'utf8')).toBe(damaged);
        await fs.writeFile(path.join(state.stateDir(),'workspace.json'),baseline);
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.waitFor(()=>expect(calls('jobs/claim')).toHaveLength(1));
        expect(calls('heartbeat').length).toBeGreaterThan(0);expect(startRoleMcpPoller).toHaveBeenCalledOnce();
    });
    it('retains an already admitted job and completion while refusing further work until the full report recovers',async()=>{
        let enter!:()=>void,release!:()=>void,claimed=false;
        const entered=new Promise<void>(done=>{enter=done;}),gate=new Promise<void>(done=>{release=done;});
        const jobId='11111111-1111-4111-8111-111111111111',lease='33333333-3333-4333-8333-333333333333';
        const bindingId=await projectBindingId('test-project');
        vi.mocked(state.api).mockImplementation(async route=>{
            if(route==='jobs/claim'){
                if(claimed)return null as never;claimed=true;
                return {id:jobId,lease,kind:'install',project_id:'test-project',payload:{package:packageFixture(),bindingId}}as never;
            }
            return {}as never;
        });
        vi.mocked(install).mockImplementation(async(_project,_package,authorize)=>{await authorize?.();enter();await gate;return {}as never;});
        worker=runWorker();await entered;
        const poller=vi.mocked(startRoleMcpPoller).mock.results[0]!.value;
        const canClaim=vi.mocked(startRoleMcpPoller).mock.calls[0]![0]!.canClaim!;
        expect(canClaim()).toBe(true);
        try{
            await fs.writeFile(path.join(state.stateDir(),'workspace.json'),'{');await vi.advanceTimersByTimeAsync(15_000);
            await vi.waitFor(()=>expect(calls('presence').length).toBeGreaterThan(0));
            expect(canClaim()).toBe(false);expect(poller.stop).not.toHaveBeenCalled();expect(calls('jobs/claim')).toHaveLength(1);
            release();await worker;
            expect(calls(`jobs/${jobId}/complete`)[0]?.[1]).toMatchObject({lease,state:'succeeded'});
            expect(calls('jobs/claim')).toHaveLength(1);
            await fs.writeFile(path.join(state.stateDir(),'workspace.json'),baseline);await vi.advanceTimersByTimeAsync(15_000);
            await vi.waitFor(()=>expect(calls('jobs/claim')).toHaveLength(2));expect(canClaim()).toBe(true);expect(startRoleMcpPoller).toHaveBeenCalledOnce();
        }finally{release();}
    });
    it('does not send private report failures or substitute an empty snapshot when an older server refuses presence',async()=>{
        vi.spyOn(workspace,'workspaceReport').mockRejectedValue(new Error('PRIVATE_PATH_AND_SECRET'));
        vi.mocked(state.api).mockImplementation(async route=>{if(route==='presence')throw new Error('Presence HTTP 404: update the server');return {}as never;});
        worker=runWorker();await worker;
        expect(calls('presence')).toHaveLength(1);expect(calls('heartbeat')).toHaveLength(0);expect(calls('jobs/claim')).toHaveLength(0);
        expect(JSON.stringify(calls('presence'))).not.toContain('PRIVATE_PATH_AND_SECRET');
        const output=vi.mocked(process.stderr.write).mock.calls.map(([text])=>String(text)).join('');
        expect(output).toContain('HTTP 404');expect(output).not.toContain('PRIVATE_PATH_AND_SECRET');
    });
});
