import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {deferred,disposeHandoffFixtures,GiB,handoffFixture,handoffMocks} from './package-build-capacity-handoff.fixture';
import {runtimeReportFixture} from './package-build-runtime.fixture';

afterEach(disposeHandoffFixtures);
describe('Build growth reservation hands off only after verified producer completion',()=>{
    it('admits 5.4GiB, accounts 0.5GiB stage in statfs and allows archive/blob copies without double-counting 4GiB',async()=>{
        const f=await handoffFixture();await f.run();
        expect(f.row.state,JSON.stringify(f.failure())).toBe('SUCCEEDED');expect(f.importArchive).toHaveBeenCalledOnce();expect(f.prepareLocal).toHaveBeenCalledOnce();
        expect(f.outer().release).toHaveBeenCalledOnce();
        expect(await fs.readFile(path.join(f.storeRoot,f.archive.descriptor.sha256+'.tar.gz'))).toEqual(f.archive.archive);
        expect(await fs.readFile(await f.blobs.checkedPath(f.archive.descriptor.sha256,f.archive.descriptor.compressedBytes))).toEqual(f.archive.archive);
        await expect(fs.stat(path.join(f.stageRoot,f.row.id))).rejects.toMatchObject({code:'ENOENT'});await f.noLeak();
    });
    it('a reap callback while the builder is still pending and an unsettled runtime retain the growth reservation',async()=>{
        const f=await handoffFixture(),writer=deferred(),reaped=deferred(),verified=deferred(),build=handoffMocks.build.getMockImplementation()!,verify=handoffMocks.verify.getMockImplementation()!;
        handoffMocks.build.mockImplementation(async(...args)=>{const result=await build(...args);reaped.resolve();await writer.promise;return result;});
        handoffMocks.verify.mockImplementation(async(...args)=>{await verified.promise;return verify(...args);});
        const pending=f.run();
        try{
            await reaped.promise;
            expect(f.outer().release).not.toHaveBeenCalled();expect(f.importArchive).not.toHaveBeenCalled();
            writer.resolve();await vi.waitFor(()=>expect(handoffMocks.verify).toHaveBeenCalledOnce());
            expect(f.outer().release).not.toHaveBeenCalled();expect(f.importArchive).not.toHaveBeenCalled();
        }finally{writer.resolve();verified.resolve();await pending;}
        expect(f.row.state,JSON.stringify(f.failure())).toBe('SUCCEEDED');expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
    it('retains the reservation across a bounded repair and the next producer attempt',async()=>{
        const f=await handoffFixture(),second=deferred(),entered=deferred(),build=handoffMocks.build.getMockImplementation()!;
        f.row.config.agent={modelId:'fixture',expectedModelPin:'a'.repeat(64),maxAttempts:2};
        const propose=vi.fn(async(config)=>config),review=vi.fn().mockResolvedValueOnce({decision:'repair',config:f.row.config}).mockResolvedValueOnce({decision:'publish'});
        Object.assign(f.service,{agent:{propose,review}});
        handoffMocks.build.mockImplementation(async(...args)=>{const manifest=await build(...args);if(handoffMocks.build.mock.calls.length===2){entered.resolve();await second.promise;}return manifest;});
        const pending=f.run();
        try{await entered.promise;expect(f.outer().release).not.toHaveBeenCalled();expect(f.importArchive).not.toHaveBeenCalled();}
        finally{second.resolve();await pending;}
        expect(f.row.state,JSON.stringify(f.failure())).toBe('SUCCEEDED');expect(f.repository.nextAttempt).toHaveBeenCalledOnce();
        expect(handoffMocks.build).toHaveBeenCalledTimes(2);expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
    it('a successful builder without explicit tree proof retains its envelope through import admission',async()=>{
        const f=await handoffFixture({reaped:false}),importArchive=f.originalImport;let releaseCalls=-1;
        f.importArchive.mockImplementation(async(...args)=>{releaseCalls=f.outer().release.mock.calls.length;return importArchive(...args);});await f.run();
        expect(releaseCalls).toBe(0);expect(JSON.stringify(f.failure()),JSON.stringify(f.failure())).toContain('Недостаточно свободного места');
        expect(f.row.state).toBe('FAILED');expect(f.prepareLocal).not.toHaveBeenCalled();expect(handoffMocks.publish).not.toHaveBeenCalled();
        expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
    it('an unreaped producer error never enters import or performs a phase handoff',async()=>{
        const f=await handoffFixture({reaped:false}),build=handoffMocks.build.getMockImplementation()!;
        handoffMocks.build.mockImplementation(async(...args)=>{await build(...args);throw f.unreaped();});await f.run();
        expect(f.importArchive).not.toHaveBeenCalled();expect(f.prepareLocal).not.toHaveBeenCalled();expect(f.outer().release).toHaveBeenCalledOnce();
        expect(await fs.stat(path.join(f.stageRoot,f.row.id))).toBeDefined();await f.noLeak();
    });
    it('cancel during runtime verification cannot release the active envelope into an import',async()=>{
        const f=await handoffFixture(),hold=deferred();
        handoffMocks.verify.mockImplementation(async(manifest:string,identity:string)=>{await hold.promise;return runtimeReportFixture(manifest,identity);});
        const pending=f.run();try{await vi.waitFor(()=>expect(handoffMocks.verify).toHaveBeenCalledOnce());f.cancel();expect(f.outer().release).not.toHaveBeenCalled();}
        finally{hold.resolve();await pending;}
        expect(f.importArchive).not.toHaveBeenCalled();expect(f.row.state).toBe('CANCELLED');expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
    it('a changed candidate fails its actual identity proof before any handoff or import',async()=>{
        const f=await handoffFixture();
        handoffMocks.verify.mockImplementation(async(manifest:string,identity:string)=>{const report=await runtimeReportFixture(manifest,identity);await fs.appendFile(manifest,' ');return report;});
        await f.run();expect(f.row.state).toBe('FAILED');expect(f.importArchive).not.toHaveBeenCalled();expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
    it('actual import capacity still refuses a filesystem below its 1GiB floor after the handoff',async()=>{
        const f=await handoffFixture({remaining:0.9*GiB}),importArchive=f.originalImport;let releaseCalls=-1;
        f.importArchive.mockImplementation(async(...args)=>{releaseCalls=f.outer().release.mock.calls.length;return importArchive(...args);});await f.run();
        expect(releaseCalls).toBe(1);expect(JSON.stringify(f.failure()),JSON.stringify(f.failure())).toContain('Недостаточно свободного места');
        expect(f.row.state).toBe('FAILED');expect(f.prepareLocal).not.toHaveBeenCalled();expect(handoffMocks.publish).not.toHaveBeenCalled();expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
    it('required snapshot spent accounting remains conservative until a fresh epoch',async()=>{
        const f=await handoffFixture({required:true});let activeCode:unknown;
        handoffMocks.verify.mockImplementation(async(manifest:string,identity:string)=>{
            try{(await f.freshSample())();}catch(error){activeCode=(error as {code?:string}).code;}
            return runtimeReportFixture(manifest,identity);
        });
        await f.run();expect(activeCode).toBe('CAPACITY_LOW');expect(JSON.stringify(f.failure()),JSON.stringify(f.failure())).toContain('Недостаточно свободного места');
        expect(f.row.state).toBe('FAILED');expect(f.prepareLocal).not.toHaveBeenCalled();expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
    it('cancel after handoff waits for an admitted import to settle before deleting its stage',async()=>{
        const f=await handoffFixture(),hold=deferred(),entered=deferred();let admitted=false;
        f.onReserve(async request=>{if(request.path===f.storeRoot&&request.bytes===f.archive.descriptor.compressedBytes){admitted=true;entered.resolve();await hold.promise;}});
        const pending=f.run();
        try{
            await Promise.race([entered.promise,pending]);expect(admitted).toBe(true);expect(f.outer().release).toHaveBeenCalledOnce();f.cancel();
            expect(await fs.stat(path.join(f.stageRoot,f.row.id))).toBeDefined();expect(handoffMocks.publish).not.toHaveBeenCalled();
        }finally{hold.resolve();await pending;}
        expect(f.row.state).toBe('CANCELLED');expect(handoffMocks.publish).not.toHaveBeenCalled();expect(f.outer().release).toHaveBeenCalledOnce();await f.noLeak();
    });
});
