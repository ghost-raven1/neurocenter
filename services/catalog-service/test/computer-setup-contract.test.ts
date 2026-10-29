import {describe,expect,it,vi} from 'vitest';
import {normalizeOpenCodeCliRequest,normalizeOpenCodeCliPayload,normalizeOpenCodeCliResult,OPENCODE_CLI_INSPECT_JOB,OPENCODE_CLI_CAPABILITY} from '../../shared/computer-setup.cjs';
import {requiredJobFeatures,requiredRouteFeatures} from '../../shared/feature-policy.cjs';
import {assertComputerSetupJob,completeComputerSetup} from '../src/devices/computer-setup-jobs';
import {deviceJobRetryPolicy} from '../src/devices/device-job-retry';
import {canCancelBridgeJob} from '../src/operations/operation-action-policy';
import type {Device} from '../src/devices/device-store';

const deviceId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const request={deviceId,kind:OPENCODE_CLI_INSPECT_JOB,scope:'global',requestKey:jobId};
const payload={schemaVersion:1,scope:'global',deviceId};
const result={...payload,jobId,checkedAt:'2026-10-27T00:00:00.000Z',status:'installed',version:'1.14.48'};
const device={id:deviceId,email:'owner@fixture.test',role:'Наблюдатель',report:{capabilities:[OPENCODE_CLI_CAPABILITY]}} as Device;
const job={id:jobId,kind:OPENCODE_CLI_INSPECT_JOB,payload,project_id:null,device_id:deviceId,email:device.email,role:device.role,state:'running',result:null};

describe('Fixed user OpenCode CLI contract',()=>{
    it('accepts exactly a global computer request and a versioned dispatcher payload',()=>{
        expect(normalizeOpenCodeCliRequest(request)).toEqual(request);
        expect(normalizeOpenCodeCliPayload(payload)).toEqual(payload);
    });
    it('keeps issued lowercase alphabetic UUID identities unchanged',()=>{
        const deviceId='abcdefab-cdef-4abc-8def-abcdefabcdef',jobId='12345678-abcd-4abc-8abc-123456789abc';
        expect(normalizeOpenCodeCliRequest({...request,deviceId})).toEqual({...request,deviceId});
        expect(normalizeOpenCodeCliPayload({...payload,deviceId})).toEqual({...payload,deviceId});
        expect(normalizeOpenCodeCliResult({...result,deviceId,jobId})).toEqual({...result,deviceId,jobId});
    });
    it.each(['request-device','payload-device','result-device','result-job'])('rejects noncanonical uppercase identity in %s before an expected-identity comparison',kind=>{
        const upper='ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
        const normalize=()=>kind==='request-device'?normalizeOpenCodeCliRequest({...request,deviceId:upper})
            :kind==='payload-device'?normalizeOpenCodeCliPayload({...payload,deviceId:upper})
                :normalizeOpenCodeCliResult({...result,...(kind==='result-device'?{deviceId:upper}:{jobId:upper})});
        expect(normalize).toThrow();
    });
    it.each([null,[],{}, {...request,scope:'project'},{...request,deviceId:null},{...request,requestKey:'-'.repeat(36)},{...request,requestKey:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'},
        {...request,projectId:null},{...request,projectId:''},{...request,command:'opencode --version'},{...request,path:'/private/bin/opencode'},
        {...request,args:['--version']},{...request,token:'private'},{...request,scope:undefined}])('rejects non-exact browser admission %j',input=>{
        expect(()=>normalizeOpenCodeCliRequest(input)).toThrow();
    });
    it.each([{...payload,command:'opencode'}, {...payload,path:'/private'}, {...payload,deviceId:jobId,projectId:'project'},null,[]])('rejects unsupported dispatcher fields %j',input=>{
        expect(()=>normalizeOpenCodeCliPayload(input)).toThrow();
    });
    it.each(['installed','missing','failed','timed-out'])('accepts only the public fields for %s',status=>{
        const {version,...observation}=result;
        const value={...observation,status,...(status==='installed'?{version}:{})};
        expect(normalizeOpenCodeCliResult(value,{deviceId,jobId})).toEqual(value);
    });
    it.each([{...result,deviceId:jobId},{...result,jobId:deviceId},{...result,checkedAt:'2026-10-27'},
        {...result,checkedAt:'2026-10-27T00:00:00+00:00'},{...result,checkedAt:null},{...result,version:'OpenCode 1.14.48'},
        {...result,version:'1.14.48\nAPI_KEY=private'},{...result,status:'unknown'},{...result,status:'missing'},
        {...result,stdout:'private'},{...result,stderr:'private'},{...result,path:'/private'},{...result,token:'private'},{}])('rejects identity, time, version and data leaks %j',input=>{
        expect(()=>normalizeOpenCodeCliResult(input,{deviceId,jobId})).toThrow();
    });
    it.each(['Главный админ','Админ проекта','Разработчик','Наблюдатель'])('allows an owned computer with valid read role %s',role=>{
        expect(()=>assertComputerSetupJob({...device,role},{...job,role})).not.toThrow();
    });
    it.each([{device_id:jobId},{email:'other@fixture.test'},{project_id:'project'},{role:'unknown'}])('refuses a different owner, project or role %j',change=>{
        expect(()=>assertComputerSetupJob(device,{...job,...change})).toThrow();
    });
    it('requires the precise bridge capability and preserves active cancellation without unsafe generic retry',()=>{
        expect(()=>assertComputerSetupJob({...device,report:{capabilities:[]}},job)).toThrow(/Обновите мост/);
        expect(requiredJobFeatures(OPENCODE_CLI_INSPECT_JOB)).toEqual(['computer_setup']);
        expect(requiredRouteFeatures('POST','/api/device-jobs',request)).toEqual([]);
        expect(deviceJobRetryPolicy(OPENCODE_CLI_INSPECT_JOB)).toMatchObject({retrySupported:false,minimumLevel:1});
        for(const state of ['queued','running','reconciling'])expect(canCancelBridgeJob(OPENCODE_CLI_INSPECT_JOB,state)).toBe(true);
        for(const state of ['succeeded','failed','cancelled'])expect(canCancelBridgeJob(OPENCODE_CLI_INSPECT_JOB,state)).toBe(false);
    });
    it('acknowledges cancelled late results without writing their untrusted contents',async()=>{
        const query=vi.fn();
        expect(await completeComputerSetup({query} as never,{...job,state:'cancelled'},
            {lease:jobId,state:'succeeded',message:'private',result:{stdout:'private'}})).toEqual({ok:true,repeated:true,cancelled:true});
        expect(query).not.toHaveBeenCalled();
    });
    it('terminal exact replay has no new authority check, while a changed observation conflicts',async()=>{
        const query=vi.fn(),input={lease:jobId,state:'succeeded' as const,message:'private',result};
        expect(await completeComputerSetup({query} as never,{...job,state:'succeeded',result},input)).toEqual({ok:true,repeated:true});
        await expect(completeComputerSetup({query} as never,{...job,state:'succeeded',result},{...input,result:{...result,version:'1.14.49'}}))
            .rejects.toMatchObject({status:409,response:{code:'computer-setup-receipt-conflict'}});
        expect(query).not.toHaveBeenCalled();
    });
});
