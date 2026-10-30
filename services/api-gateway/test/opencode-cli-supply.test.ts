import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {OpenCodeCliSupplyController} from '../src/bridge/opencode-cli-supply.controller';

describe.sequential('canonical OpenCode install metadata',()=>{
    const buildId='a'.repeat(64),sha256='b'.repeat(64),token='own-fixture-internal';
    let probe:unknown,supply:ReturnType<typeof vi.fn>,controller:OpenCodeCliSupplyController,req:EventEmitter,res:EventEmitter;
    beforeEach(()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);probe={file:'bin/opencode-probe',version:'1.14.48',sha256};
        supply=vi.fn(async()=>({buildId,artifacts:[{target:'linux-x64',metadata:{probeEngine:probe}}]}));controller=new OpenCodeCliSupplyController({supply} as never);req=new EventEmitter();res=new EventEmitter();});
    afterEach(()=>vi.unstubAllEnvs());
    const call=function(this:void,controller:OpenCodeCliSupplyController,req:EventEmitter,res:EventEmitter,key:string,target='linux-x64'){
        return controller.current(key,target,req as never,res as never);
    };
    it('returns exact current Linux archive target and removes request listeners',async()=>{
        expect(await call(controller,req,res,token)).toEqual({buildId,target:'linux-x64',version:'1.14.48',sha256});
        expect(req.listenerCount('aborted')).toBe(0);expect(res.listenerCount('close')).toBe(0);
    });
    it.each(['','incorrect','own-fixture-internaℓ'])('rejects unauthorized internal caller before supply reads',async key=>{
        await expect(call(controller,req,res,key)).rejects.toMatchObject({status:403});expect(supply).not.toHaveBeenCalled();
    });
    it('cannot select a path or a missing platform',async()=>{
        await expect(call(controller,req,res,token,'../darwin-arm64')).rejects.toMatchObject({status:404});expect(supply).not.toHaveBeenCalled();
        await expect(call(controller,req,res,token,'darwin-arm64')).rejects.toMatchObject({status:404});
    });
    it.each([undefined,{file:'other',version:'1.14.48',sha256},{file:'bin/opencode-probe',version:'1.14.49',sha256}])('fails closed for an unapproved binary %#',async value=>{
        probe=value;await expect(call(controller,req,res,token)).rejects.toMatchObject({status:404});
    });
    it('client disconnect cancels the canonical supply read',async()=>{
        supply.mockImplementationOnce(async(signal:AbortSignal)=>{req.emit('aborted');signal.throwIfAborted();});
        await expect(call(controller,req,res,token)).rejects.toBeDefined();expect(req.listenerCount('aborted')).toBe(0);
    });
});
