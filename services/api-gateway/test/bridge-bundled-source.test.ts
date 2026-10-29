import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {BridgeSupplyService} from '../src/bridge/bridge-supply.service';
const version='0.9.27',buildId='a'.repeat(64),sha256='b'.repeat(64),target='darwin-arm64',bytes=123;
const supply=(sourceCommit:string)=>({assetId:'neurocenter-bridge',version,buildId,sourceCommit,artifacts:[{file:`neurocenter-asset-sync-${target}-${version}.tgz`,target,sha256,bytes,
    metadata:{version,buildId,target,sha256,bytes,nodeVersion:'24.22.0',ragSupported:true,probeEngine:{version:'1.14.48',file:'bin/opencode-probe',sha256:'c'.repeat(64)}}}]});
function service(data:unknown){const get=vi.fn(async()=>({status:200,data}));return {get,source:Object.assign(Object.create(BridgeSupplyService.prototype),{catalogUrl:'https://catalog.owned.invalid',http:{get}}) as BridgeSupplyService};}
beforeEach(()=>vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','owned-bundle-gateway-test'));
afterEach(()=>vi.unstubAllEnvs());
describe('Gateway preserves exact imported bridge supply provenance',()=>{
    it.each(['d'.repeat(40),'sha256:'+'d'.repeat(64)])('Accepts the immutable Git or explicit content identity %s without converting it',async commit=>{
        const data=supply(commit),fixture=service(data),signal=new AbortController().signal;
        expect(await fixture.source.supply(signal,version)).toEqual(data);expect(fixture.get).toHaveBeenCalledOnce();
        expect(fixture.get).toHaveBeenCalledWith('https://catalog.owned.invalid/internal/asset-sources/bridge',expect.objectContaining({signal,params:{version}}));
    });
    it.each(['d'.repeat(64),'sha256:'+'d'.repeat(40),'sha256:'+'D'.repeat(64),'main','sha256:bad'])('Rejects ambiguous or malformed source identity %s',async commit=>{
        await expect(service(supply(commit)).source.supply(new AbortController().signal)).rejects.toMatchObject({status:503});
    });
    it('Content identity cannot relax the archive inventory or become an external download URL',async()=>{
        const data=supply('sha256:'+'d'.repeat(64));
        await expect(service({...data,artifacts:[{...data.artifacts[0],url:'https://example.invalid/archive'}]}).source.supply(new AbortController().signal)).rejects.toMatchObject({status:503});
        await expect(service({...data,artifacts:[{...data.artifacts[0],bytes:0}]}).source.supply(new AbortController().signal)).rejects.toMatchObject({status:503});
    });
});
