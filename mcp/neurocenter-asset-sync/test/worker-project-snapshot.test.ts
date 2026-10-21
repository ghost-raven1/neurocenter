import fs from 'node:fs/promises';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as state from '../src/bridge/state.js';
import * as workspace from '../src/bridge/workspace.js';
import {runWorker} from '../src/bridge/worker.js';
import {publishProjectSnapshot} from '../src/features/project-snapshot/publish.js';
import {workspaceFixture} from './bridge-fixture.js';
import {BRIDGE_CAPABILITIES} from '../src/bridge/protocol.js';
const socket=vi.hoisted(()=>({auth:{},on:vi.fn(),disconnect:vi.fn(),connect:vi.fn()}));
vi.mock('socket.io-client',()=>({io:vi.fn(()=>socket)}));
vi.mock('../src/bridge/state.js',async original=>({...await original<typeof import('../src/bridge/state.js')>(),api:vi.fn()}));
vi.mock('../src/features/project-snapshot/publish.js',()=>({publishProjectSnapshot:vi.fn()}));

describe('Leased full-image worker intent',()=>{
 let fixture:Awaited<ReturnType<typeof workspaceFixture>>,signals:Map<NodeJS.Signals,Set<(...args:unknown[])=>void>>,bindingId:string;
 const id='11111111-1111-4111-8111-111111111111',lease='22222222-2222-4222-8222-222222222222',deviceId='33333333-3333-4333-8333-333333333333',snapshotId='44444444-4444-4444-8444-444444444444';
 beforeEach(async()=>{fixture=await workspaceFixture();vi.clearAllMocks();signals=new Map(['SIGTERM','SIGINT'].map(signal=>[signal as NodeJS.Signals,new Set(process.listeners(signal))]));
  await state.writeState('credentials',{token:'fixture',deviceId,email:'fixture@example.test'});bindingId=await workspace.projectBindingId('test-project');vi.spyOn(workspace,'workspaceReport').mockResolvedValue({} as never);
  vi.spyOn(process.stderr,'write').mockReturnValue(true);vi.spyOn(process,'exit').mockImplementation((()=>undefined) as never);socket.disconnect.mockReturnValue(socket);socket.connect.mockReturnValue(socket);
 });
 afterEach(async()=>{const stop=process.listeners('SIGTERM').find(listener=>!signals.get('SIGTERM')!.has(listener));stop?.();if(stop)await vi.waitFor(()=>expect(process.exit).toHaveBeenCalled());
  for(const [signal,previous]of signals)for(const listener of process.listeners(signal))if(!previous.has(listener))process.off(signal,listener);vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
 function queue(protocol='project-snapshots-v1',binding=bindingId){let claimed=false;vi.mocked(state.api).mockImplementation(async route=>{if(route==='jobs/claim'){if(claimed)return null as never;claimed=true;return{id,lease,kind:'publish-project-snapshot',project_id:'test-project',payload:{snapshotId,snapshotProtocol:protocol,bindingId:binding}} as never;}return{} as never;});}
 const completion=()=>vi.mocked(state.api).mock.calls.find(([route])=>route===`jobs/${id}/complete`)?.[1];
 it('advertises the exact new capability and preserves selected binding and live job context',async()=>{
  queue();const result={projectId:'test-project',bindingId,snapshotId,status:'UPLOADED',manifestSha256:'a'.repeat(64),bytes:100,fileCount:3,tableCount:2};
  vi.mocked(publishProjectSnapshot).mockImplementation(async(input,authorize)=>{expect(input).toEqual({projectId:'test-project',bindingId,snapshotId,snapshotProtocol:'project-snapshots-v1'});expect(state.jobContext.getStore()).toEqual({id,lease,deviceId});await authorize();return result;});
  await runWorker();expect(BRIDGE_CAPABILITIES).toContain('project-snapshots-v1');expect(completion()).toMatchObject({state:'succeeded',message:'Полный образ передан. Сервер проверяет снимок.',result});
 });
 it.each(['wrong protocol','wrong binding'])('%s is rejected before touching an image',async issue=>{queue(issue==='wrong protocol'?'old-snapshot':'project-snapshots-v1',issue==='wrong binding'?'b'.repeat(64):bindingId);await runWorker();expect(publishProjectSnapshot).not.toHaveBeenCalled();expect(completion()).toMatchObject({state:'failed',result:{}});});
 it('reauthorization fences a binding changed during capture',async()=>{queue();vi.mocked(publishProjectSnapshot).mockImplementation(async(_input,authorize)=>{vi.spyOn(workspace,'projectBindingId').mockResolvedValue('b'.repeat(64));await authorize();throw new Error('unreachable');});await runWorker();expect(completion()).toMatchObject({state:'failed'});});
 it('does not expose filesystem/private diagnostics in the device result',async()=>{queue();vi.mocked(publishProjectSnapshot).mockRejectedValue(new Error('/Users/private/FAKE_SECRET'));await runWorker();expect(JSON.stringify(completion())).not.toMatch(/\/Users|FAKE_SECRET/);expect(completion()).toMatchObject({state:'failed'});});
 it('does not save a false failure after an uncertain accepted upload',async()=>{queue();vi.mocked(publishProjectSnapshot).mockRejectedValue(Object.assign(new Error('Сервер восстановит состояние публикации.'),{localChangesCommitted:true}));await runWorker();expect(completion()).toBeUndefined();});
});
