import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AxiosAdapter} from 'axios';
import base from '../src/core/api/base';
import {projectSnapshotsApi} from '../src/features/ProjectSnapshots/api';
import type {SnapshotIntent} from '../src/features/ProjectSnapshots/types';
const original=base.defaults.adapter;
afterEach(()=>{base.defaults.adapter=original;});
const create=():SnapshotIntent=>({projectId:'project/a b',kind:'create',input:{requestKey:crypto.randomUUID(),deviceId:crypto.randomUUID(),expectedBindingId:'a'.repeat(64),expectedHeadId:null,expectedHeadRevision:0}});
describe('Snapshot API exact payload/recovery boundary',()=>{
    it('Uses encoded project scope, cookie security, bounded timeout and original create body',async()=>{
        const adapter=vi.fn<AxiosAdapter>(async config=>({data:{snapshotId:'one'},status:200,statusText:'OK',headers:{},config}));base.defaults.adapter=adapter;
        const intent=create();await projectSnapshotsApi.submit(intent);const config=adapter.mock.calls[0][0];expect(config.url).toBe('/api/projects/project%2Fa%20b/versions');expect(JSON.parse(config.data)).toEqual(intent.input);expect(config.timeout).toBe(30000);expect(config.withCredentials).toBe(true);expect(config.headers.get('X-Neurocenter-Request')).toBe('1');
    });
    it('Create missing receipt stays null; command receipt unwraps result without a second POST',async()=>{
        const adapter=vi.fn<AxiosAdapter>().mockImplementationOnce(async config=>({data:null,status:200,statusText:'OK',headers:{},config})).mockImplementationOnce(async config=>({data:{result:{headId:'saved',headRevision:4}},status:200,statusText:'OK',headers:{},config}));base.defaults.adapter=adapter;
        const intent=create();expect(await projectSnapshotsApi.lookup(intent)).toBeNull();expect(adapter.mock.calls[0][0].url).toContain('/versions/requests/'+intent.input.requestKey);
        const command:SnapshotIntent={projectId:intent.projectId,kind:'activate',snapshotId:crypto.randomUUID(),input:{requestKey:crypto.randomUUID(),expectedHeadId:null,expectedHeadRevision:0}};
        expect(await projectSnapshotsApi.lookup(command)).toEqual({headId:'saved',headRevision:4});expect(adapter.mock.calls[1][0].url).toContain('/versions/commands/');expect(adapter.mock.calls.every(([config])=>config.method==='get')).toBe(true);
    });
    it('Unknown create cancellation carries exact original input; command cancellation has no body',async()=>{
        const adapter=vi.fn<AxiosAdapter>(async config=>({data:{cancelled:true},status:200,statusText:'OK',headers:{},config}));base.defaults.adapter=adapter;const intent=create();await projectSnapshotsApi.cancelRequest(intent);
        expect(JSON.parse(adapter.mock.calls[0][0].data)).toEqual(intent.input);
        await projectSnapshotsApi.cancelRequest({projectId:'p',kind:'cancel',snapshotId:crypto.randomUUID(),input:{requestKey:crypto.randomUUID()}});
        expect(adapter.mock.calls[1][0].url).toContain('/versions/commands/');expect(adapter.mock.calls[1][0].data).toBeUndefined();
    });
    it('Delete supplies exact manifest/grace/requestKey in DELETE body; release includes both CAS scopes',async()=>{
        const adapter=vi.fn<AxiosAdapter>(async config=>({data:{},status:200,statusText:'OK',headers:{},config}));base.defaults.adapter=adapter;
        const requestKey=crypto.randomUUID(),snapshotId=crypto.randomUUID(),input={requestKey,expectedManifest:'b'.repeat(64),gracePeriodHours:24};await projectSnapshotsApi.submit({projectId:'p',kind:'delete',snapshotId,input});expect(adapter.mock.calls[0][0].method).toBe('delete');expect(JSON.parse(adapter.mock.calls[0][0].data)).toEqual(input);
        const release:SnapshotIntent={projectId:'p',kind:'release',input:{requestKey:crypto.randomUUID(),snapshotId,expectedProfileId:null,expectedProfileRevision:3,moveHead:{expectedHeadId:null,expectedHeadRevision:5}}};await projectSnapshotsApi.submit(release);expect(JSON.parse(adapter.mock.calls[1][0].data)).toEqual(release.input);
    });
});
