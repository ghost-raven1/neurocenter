import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createCliObservationController} from '../src/features/ComputerSetup/controller';
import {initialCliObservation,type CliIntent} from '../src/features/ComputerSetup/model';
import {cliStorageKey} from '../src/features/ComputerSetup/storage';
import {installationReconciled} from '../src/features/ComputerSetup/installationState';
import {at,deviceId,jobId,requestKey,email,envelope,deferred,journal,httpError,completed} from './computer-setup.fixture';

const kind='install-opencode-cli',role='Разработчик',source={buildId:'a'.repeat(64),target:'darwin-arm64',version:'1.14.48',sha256:'b'.repeat(64)};
const input={deviceId,kind,scope:'global',requestKey} as const;
const intent:CliIntent={version:1,email,role,request:input};
const job=(state='queued',status='installed')=>({id:jobId,deviceId,kind,projectId:null,state,createdAt:at,updatedAt:at,result:state==='queued'?null:{schemaVersion:1,scope:'global',deviceId,jobId,source,checkedAt:at,status,
    installedVersion:status==='unknown'?null:'1.14.48',commandVersion:null,commandReady:false,nextAction:status==='unknown'?'reconcile':'inspect-path',...(status==='unknown'?{failure:'interrupted'}:{})}});
function setup(raw:string|null=null){
    const storage=journal(raw),api={list:vi.fn().mockResolvedValue([]),create:vi.fn().mockResolvedValue(job()),request:vi.fn().mockResolvedValue(envelope(intent,job())),cancel:vi.fn().mockResolvedValue(undefined)};
    const control={owns:true,enabled:true},changed=vi.fn();let state=initialCliObservation();
    const controller=createCliObservationController({email,role,deviceId,kind,api,storage,lock:async(_key,change)=>change(),requestKey:()=>requestKey,
        canStart:()=>control.enabled,canCancel:()=>true,captureOwner:()=>()=>control.owns,onChange:next=>{state=next;changed(next);}});
    controller.activate();return {controller,api,control,storage,changed,state:()=>state};
}
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());

it('never installs automatically, and an explicit click has only the fixed four-field request',async()=>{
    const h=setup();await h.controller.refresh();await h.controller.automatic();expect(h.api.create).not.toHaveBeenCalled();
    await h.controller.start();expect(h.api.create).toHaveBeenCalledExactlyOnceWith(input,expect.any(AbortSignal));
    expect(cliStorageKey(email,deviceId,kind)).not.toBe(cliStorageKey(email,deviceId));h.controller.dispose();
});
it('lost installation ACK recovers the accepted UUID and reload never copies again',async()=>{
    const h=setup();h.api.create.mockRejectedValueOnce(Error('ACK lost'));await h.controller.refresh();await h.controller.start();
    expect(h.state().intent?.jobId).toBe(jobId);expect(h.api.create).toHaveBeenCalledOnce();const raw=h.storage.raw();h.controller.dispose();
    const next=setup(raw);await next.controller.refresh();await next.controller.automatic();expect(next.api.create).not.toHaveBeenCalled();
    expect(next.api.request).toHaveBeenCalledExactlyOnceWith(requestKey,expect.any(AbortSignal));next.controller.dispose();
});
it('a publication with uncertain outcome blocks a new installation until a newer explicit inspection',async()=>{
    const h=setup();h.api.list.mockResolvedValue([job('failed','unknown')]);await h.controller.refresh();await h.controller.start();
    expect(h.api.create).not.toHaveBeenCalled();expect(h.state().error).toContain('Сначала проверьте OpenCode');
    const uncertain=h.state().job!;
    expect(installationReconciled(uncertain,[completed('missing')])).toBe(false);
    const inspection={...completed('missing'),createdAt:'2026-10-28T00:02:00.000Z'};
    expect(installationReconciled(uncertain,[inspection])).toBe(true);
    h.api.list.mockResolvedValue([job('failed','unknown'),inspection]);await h.controller.start();
    expect(h.api.create).toHaveBeenCalledExactlyOnceWith(input,expect.any(AbortSignal));h.controller.dispose();
});
it('OFF retains accepted installation history and cancellation without creating another request',async()=>{
    const h=setup(JSON.stringify({...intent,jobId}));h.control.enabled=false;await h.controller.refresh();
    await h.controller.start();h.api.request.mockResolvedValue(envelope(intent,{...job(),state:'cancelled'}));await h.controller.cancel();
    expect(h.api.cancel).toHaveBeenCalledOnce();expect(h.api.create).not.toHaveBeenCalled();expect(h.state().job?.state).toBe('cancelled');h.controller.dispose();
});
it('late POST acknowledgement after device ownership changes cannot update the old journal',async()=>{
    const h=setup(),ack=deferred<unknown>(),sent=deferred<void>();h.api.create.mockImplementation(async()=>{sent.resolve();return ack.promise;});await h.controller.refresh();
    const pending=h.controller.start();await sent.promise;h.control.owns=false;h.controller.dispose();const raw=h.storage.raw(),count=h.changed.mock.calls.length;
    ack.resolve(job());await pending;expect(h.storage.raw()).toBe(raw);expect(h.changed).toHaveBeenCalledTimes(count);expect(h.api.request).not.toHaveBeenCalled();
});
it('missing accepted receipt never becomes a new install key or a claim that CLI is missing',async()=>{
    const h=setup(JSON.stringify({...intent,jobId}));h.api.request.mockRejectedValue(httpError(404));await h.controller.refresh();await h.controller.start();await h.controller.replay();
    expect(h.api.create).not.toHaveBeenCalled();expect(h.state().job?.observation).toBeUndefined();expect(h.storage.raw()).toContain(jobId);h.controller.dispose();
});
