import {expect,it,vi} from 'vitest';
import {PackageBuildService} from '../src/package-build/package-build.service';

/** The actual lifecycle method drains rebuild work while cancelling the active producer immediately. */
it('shutdown cancels its active producer before waiting for a held rebuild admission',async()=>{
    let entered!:()=>void,release!:()=>void;
    const began=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const cancel=vi.fn(),end=vi.fn(async()=>undefined),rebuildStop=vi.fn(async()=>{entered();await held;});
    const service=Object.assign(Object.create(PackageBuildService.prototype),{stopping:false,rebuild:{stop:rebuildStop},
        activeBuild:{cancellation:{stop:cancel}},leaseUse:Promise.resolve(),pool:{end},child:undefined,retryTimer:undefined,rebuildTimer:undefined,
        recovering:undefined,worker:undefined,lease:undefined,releaseLease:undefined}) as PackageBuildService;
    const pending=service.onModuleDestroy();
    try{
        await began;
        expect.soft(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
        expect.soft(end).not.toHaveBeenCalled();
        expect.soft(rebuildStop).toHaveBeenCalledOnce();
    }finally{release();await pending;}
    expect(cancel).toHaveBeenCalledOnce();expect(end).toHaveBeenCalledOnce();
});
