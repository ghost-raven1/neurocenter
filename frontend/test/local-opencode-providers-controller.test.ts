import {beforeEach,expect,it,vi} from 'vitest';
import {createLocalProvidersController} from '../src/features/LocalOpenCodeProviders/controller';
import {globalRequestFingerprint} from '../src/features/LocalOpenCodeProviders/model';
import type {GlobalProvidersKind} from '@neurocenter/opencode-local-providers';
const deviceId='11111111-1111-4111-8111-111111111111',requestKey='22222222-2222-4222-8222-222222222222',jobId='33333333-3333-4333-8333-333333333333';
const kind:GlobalProvidersKind='inspect-opencode-global-providers',request={kind,scope:'global' as const,deviceId,requestKey};
const inventory={providers:[{id:'openai',modelIds:[],hasConfiguration:false,hasAuthentication:true,authentication:'oauth',enabled:true}],configurationFound:false,authenticationFound:true,overrideDetected:false,issues:[]};
const job={id:jobId,deviceId,projectId:null,kind,state:'succeeded',createdAt:'2026-10-29T00:00:00.000Z',updatedAt:'2026-10-29T00:00:00.000Z',result:{schemaVersion:1,scope:'global',deviceId,jobId,kind,checkedAt:'2026-10-29T00:00:00.000Z',status:'checked',inventory}};
let map:Map<string,string>,storage:Storage,alive:boolean,canOpen:boolean,state:ReturnType<typeof createLocalProvidersController>['state'],api:any;
const make=()=>{const controller=createLocalProvidersController({owner:'durable-alice',deviceId,role:'Разработчик',storage,lock:async(_key,change)=>change(),api,captureOwner:()=>()=>alive,canRead:()=>true,canOpen:()=>canOpen,requestKey:()=>requestKey,onChange:value=>{state=value;}});controller.activate();state=controller.state;return controller;};
beforeEach(()=>{map=new Map();storage={getItem:key=>map.get(key)??null,setItem:(key,value)=>{map.set(key,value);},removeItem:key=>map.delete(key)} as Storage;alive=true;canOpen=true;api={list:vi.fn(async()=>[]),request:vi.fn(async()=>({requestKey,requestFingerprint:await globalRequestFingerprint(request,'Разработчик'),job})),create:vi.fn(async()=>job),cancel:vi.fn(async()=>{})};});
it('a lost create ACK retains one UUID and recovers the exact role/request receipt without another POST',async()=>{
    api.create.mockRejectedValueOnce(Error('ACK lost'));const controller=make();await controller.start(kind);expect(api.create).toHaveBeenCalledOnce();expect(controller.state.inventory?.providers[0].authentication).toBe('oauth');
    expect([...map.values()]).toEqual([JSON.stringify({version:1,requestKey,jobId})]);expect([...map.values()].join('')).not.toContain('openai');
    controller.dispose();const reloaded=make();await reloaded.refresh();expect(api.create).toHaveBeenCalledOnce();expect(reloaded.state.inventory?.providers[0].id).toBe('openai');
});
it('404 uncertainty offers only explicit replay of the same key; invalid receipt identity cannot create a new request',async()=>{
    api.create.mockRejectedValueOnce(Error('ACK lost'));api.request.mockRejectedValue({response:{status:404}});const controller=make();await controller.start(kind);await controller.start(kind);expect(api.create).toHaveBeenCalledOnce();expect(controller.state.canReplay).toBe(true);
    api.request.mockResolvedValue({requestKey,requestFingerprint:'wrong',job});await controller.replay(kind);expect(api.create).toHaveBeenCalledTimes(2);expect(controller.state.inventory).toBeUndefined();expect([...map.values()][0]).toContain(requestKey);
});
it('OFF permits fresh inventory but never opens a private window or starts model inference',async()=>{
    canOpen=false;const controller=make();await controller.start('open-opencode-global-providers');expect(api.create).not.toHaveBeenCalled();await controller.start(kind);expect(api.create).toHaveBeenCalledExactlyOnceWith(request,expect.any(AbortSignal));
});
it('corrupt journals survive without auto-overwrite or POST; allowed history still reads',async()=>{
    const controller=make();storage.setItem(controller.journalKey(kind),'CORRUPT');await controller.refresh();await controller.start(kind);expect(api.create).not.toHaveBeenCalled();expect(storage.getItem(controller.journalKey(kind))).toBe('CORRUPT');expect(controller.state.storageError).toBeTruthy();
});
it('late ACK after owner disposal never publishes another person’s inventory',async()=>{
    let resolve!:(value:unknown)=>void;api.create.mockReturnValue(new Promise(done=>{resolve=done;}));const controller=make(),running=controller.start(kind);await new Promise(done=>setTimeout(done,0));alive=false;controller.dispose();resolve(job);await running;expect(state.inventory).toBeUndefined();
});
it('an acknowledged opening retains its job UUID across reload and a later receipt404 never permits another POST',async()=>{
    const opening={...job,kind:'open-opencode-global-providers',state:'queued',result:undefined};api.create.mockResolvedValue(opening);api.request.mockRejectedValue({response:{status:404}});
    const controller=make();await controller.start('open-opencode-global-providers');expect(controller.state.canReplay).toBe(false);expect(JSON.parse([...map.values()][0])).toMatchObject({jobId});controller.dispose();
    const reloaded=make();await reloaded.refresh();await reloaded.replay('open-opencode-global-providers');await reloaded.start('open-opencode-global-providers');expect(api.create).toHaveBeenCalledOnce();expect(reloaded.state.canReplay).toBe(false);
});
it('a history403 fences automatic admission until an explicit successful history refresh',async()=>{
    api.list.mockRejectedValueOnce({response:{status:403}});const controller=make();await controller.refresh();expect(controller.state.denied).toBe(true);await controller.start(kind);expect(api.create).not.toHaveBeenCalled();expect(api.list).toHaveBeenCalledOnce();
    await controller.refresh();await controller.start(kind);expect(api.create).toHaveBeenCalledOnce();
});
it('inventory observed before an opening completed is retained as history, not confirmed current configuration',async()=>{
    const opening={...job,kind:'open-opencode-global-providers',createdAt:'2026-10-29T00:00:00.000Z',updatedAt:'2026-10-29T00:10:00.000Z',result:{schemaVersion:1,scope:'global',deviceId,jobId,kind:'open-opencode-global-providers',checkedAt:'2026-10-29T00:10:00.000Z',status:'opened',expiresAt:'2026-10-29T00:25:00.000Z'}};
    const earlierRead={...job,createdAt:'2026-10-29T00:05:00.000Z',updatedAt:'2026-10-29T00:06:00.000Z',result:{...job.result,checkedAt:'2026-10-29T00:06:00.000Z'}};
    api.list.mockResolvedValue([earlierRead,opening]);const controller=make();await controller.refresh();expect(controller.state.inventory).toBeUndefined();expect(controller.state.jobs[kind]).toBeTruthy();
});
