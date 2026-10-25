import {describe,expect,it,vi} from 'vitest';
import {traceToolBuild,traceSavedChat} from '../../shared/dev-trace.cjs';

const id='11111111-1111-4111-8111-111111111111',build='22222222-2222-4222-8222-222222222222';
const enabled={NEUROCENTER_DEV_TRACES:'1',NEUROCENTER_DEV_LAUNCH_ID:id};

describe('Opt-in dev trace is a bounded UUID-only stdout record',()=>{
    it('copies only fixed identities and derives the operation; private input never enters the line',()=>{
        const write=vi.fn(),now=()=>new Date('2026-01-01T00:00:00.000Z');
        const ids={requestKey:id.toUpperCase(),buildId:build,source:'private-source',token:'private-token',message:'private-error'};
        expect(traceToolBuild('accepted',ids,{environment:enabled,write,now})).toBe(true);
        expect(write).toHaveBeenCalledExactlyOnceWith(JSON.stringify({schemaVersion:1,kind:'neurocenter-dev-trace',timestamp:now().toISOString(),
            launchId:id,flow:'tool-build',event:'accepted',requestKey:id,buildId:build,operationId:'tool-build-'+build})+'\n');
        expect(write.mock.calls[0][0]).not.toContain('private');
    });
    it.each([{}, {NEUROCENTER_DEV_TRACES:'0',NEUROCENTER_DEV_LAUNCH_ID:id},
        {NEUROCENTER_DEV_TRACES:'1'}, {NEUROCENTER_DEV_TRACES:'1',NEUROCENTER_DEV_LAUNCH_ID:'caller-secret'}])('requires explicit enablement and a launcher UUID: %j',environment=>{
        const write=vi.fn();expect(traceToolBuild('requested',{requestKey:id},{environment,write})).toBe(false);expect(write).not.toHaveBeenCalled();
    });
    it('retains existing chat UUID versions while build identifiers stay UUIDv4',()=>{
        const write=vi.fn(),legacy='11111111-1111-1111-8111-111111111111';
        expect(traceToolBuild('accepted',{requestKey:legacy},{environment:enabled,write})).toBe(false);
        expect(traceSavedChat('retried',{conversationId:legacy,turnId:id,requestId:build},{environment:enabled,write})).toBe(true);
        expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({requestId:build,attemptId:build});
    });
    it('drops unknown events or non-UUID identities',()=>{
        const write=vi.fn();
        expect(traceToolBuild('source' as never,{requestKey:id},{environment:enabled,write})).toBe(false);
        expect(traceSavedChat('started',{conversationId:id,turnId:'private-prompt',requestId:build},{environment:enabled,write})).toBe(false);
        expect(write).not.toHaveBeenCalled();
    });
    it('contains synchronous and asynchronous sink failures without changing the caller',async()=>{
        expect(traceToolBuild('requested',{requestKey:id},{environment:enabled,write:()=>{throw Error('private sink failure');}})).toBe(false);
        expect(traceToolBuild('requested',{requestKey:id},{environment:enabled,write:()=>Promise.reject(Error('private callback failure'))})).toBe(true);
        await new Promise(resolve=>setImmediate(resolve));
    });
});
