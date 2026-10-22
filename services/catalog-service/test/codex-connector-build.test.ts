import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {ForbiddenException} from '@nestjs/common';
import {CODEX_PLUGIN_SOURCE} from '../../shared/codex-connector-source.cjs';
import {buildFeatures,assertCodexBuildKind,assertCodexBuildPublication} from '../src/package-build/codex-connector-build';
import type {BuildConfiguration} from '../src/package-build/package-build.model';
import type {IAiPluginCreate} from '../src/catalog/dto';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {resolveRepositorySource} from '../../shared/repository-source.cjs';
import {buildPackage} from '../src/catalog/bundle-package';

const mocks=vi.hoisted(()=>({pool:{query:vi.fn(),connect:vi.fn(),end:vi.fn()},reserve:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>mocks.pool}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:mocks.reserve}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../../shared/repository-source.cjs',async original=>({...await original<object>(),resolveRepositorySource:vi.fn()}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const {adapter:_adapter,...fixed}=CODEX_PLUGIN_SOURCE;
const source={type:'repository' as const,...fixed};
const resolved={...source,ref:fixed.commit,candidates:[fixed.entrypoint],name:'Codex fixture',description:'Pinned fixture'};
const config={kind:'plugin' as const,source};
const pin=require('../../shared/codex-connector-pin.json') as {sourceCommit:string;version:string;sdkVersion:string};
const metadata={schemaVersion:1,sourceCommit:pin.sourceCommit,version:pin.version,sdkVersion:pin.sdkVersion,authOnly:true};
const publication=():IAiPluginCreate=>({name:'Codex fixture',kind:'plugin',description:'Pinned auth-only provider',
    config:{entrypoint:'plugin.mjs',extra:{codexConnector:{...metadata},runtimeArtifacts:[{sha256:'a'.repeat(64)}]}}});

describe('Pinned Codex build admission and publication',()=>{
    it('Only exact repository source gets the separate connector flag; ordinary plugins keep their prior flags',()=>{
        expect(buildFeatures(config)).toEqual(['tool_builds','tool_catalog','codex_connector']);
        expect(buildFeatures({...config,source:{...source,commit:'a'.repeat(40)}})).toEqual(['tool_builds','tool_catalog']);
        expect(()=>assertCodexBuildPublication(config,publication())).not.toThrow();
    });
    it('The pinned repository cannot be built as an MCP server',()=>{
        expect(()=>assertCodexBuildKind({...config,kind:'mcp'})).toThrow('плагин');
    });
    it.each([{change:{sourceCommit:'a'.repeat(40)}},{change:{authOnly:false}},{change:{sdkVersion:'99.0.0'}},{change:{extra:'untrusted'}}])('Built metadata must match the immutable auth-only pin: $change',({change})=>{
        const value=publication();Object.assign(value.config!.extra!.codexConnector!,change);
        expect(()=>assertCodexBuildPublication(config,value)).toThrow('не подтвердил');
    });
    it('No runtime archive or arbitrary repository metadata can claim the prepared connector',()=>{
        const value=publication();value.config!.extra!.runtimeArtifacts=[];
        expect(()=>assertCodexBuildPublication(config,value)).toThrow('не подтвердил');
        expect(()=>assertCodexBuildPublication({...config,source:{...source,commit:'a'.repeat(40)}},publication())).toThrow('Произвольная');
        const ordinary=publication();delete ordinary.config!.extra!.codexConnector;
        expect(()=>assertCodexBuildPublication({...config,source:{...source,commit:'a'.repeat(40)}},ordinary)).not.toThrow();
    });
});

describe('Actual build create preserves resolved provenance before queueing',()=>{
    const actor={email:'builder@example.test',activeRole:'Главный админ'};
    let service:PackageBuildService;
    const enqueue=vi.fn(),claims=vi.fn(),getPackage=vi.fn();
    const request=()=>({requestKey:'11111111-1111-4111-8111-111111111111',name:'Codex fixture',kind:'plugin',description:'Pinned fixture',targets:['darwin-arm64'],
        source:{type:'repository',url:fixed.url,ref:fixed.commit,subdirectory:fixed.subdirectory,entrypoint:fixed.entrypoint}});
    beforeEach(()=>{
        vi.clearAllMocks();vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);
        vi.mocked(resolveRepositorySource).mockResolvedValue(resolved);mocks.reserve.mockResolvedValue(vi.fn());mocks.pool.query.mockResolvedValue({rows:[]});
        claims.mockResolvedValue({userRoles:['Главный админ']});
        service=new PackageBuildService({claims} as unknown as AccessDb,{} as RuntimeArtifacts,{getAiPluginPackage:getPackage} as unknown as CatalogService,{} as never);
        Object.assign(service,{lease:{query:vi.fn().mockResolvedValue({rows:[]})} as unknown as PoolClient,
            repository:{existing:vi.fn(),enqueue},stagingRoot:async()=>'/unused-codex-stage',startWorker:vi.fn()});
        enqueue.mockImplementation(async(_email,_key,_hash,configuration:BuildConfiguration)=>({id:actor.email,config:configuration,state:'QUEUED'}));
    });
    afterEach(async()=>{await service.onModuleDestroy();});
    it('UI ref becomes exact commit plus metadata-bearing server receipt configuration, without executing a builder',async()=>{
        await service.create(actor,request());
        expect(enqueue).toHaveBeenCalledOnce();expect(enqueue.mock.calls[0][3].source).toEqual(source);
        expect(requireFeaturesEnabled).toHaveBeenLastCalledWith(['tool_builds','tool_catalog','codex_connector']);
    });
    it('Connector OFF after asynchronous repository resolution refuses the new queue mutation',async()=>{
        const failure=new ForbiddenException('Codex disabled during resolution');
        vi.mocked(resolveRepositorySource).mockImplementationOnce(async()=>{vi.mocked(requireFeaturesEnabled).mockRejectedValue(failure);return resolved;});
        await expect(service.create(actor,request())).rejects.toBe(failure);expect(enqueue).not.toHaveBeenCalled();
    });
    it('Connector OFF during capacity await refuses enqueue even after source admission',async()=>{
        const failure=new ForbiddenException('Codex disabled during capacity');
        mocks.reserve.mockImplementationOnce(async()=>{vi.mocked(requireFeaturesEnabled).mockRejectedValue(failure);return vi.fn();});
        await expect(service.create(actor,request())).rejects.toBe(failure);expect(enqueue).not.toHaveBeenCalled();
    });
    it('Readiness distinguishes missing from the exact pinned running build without creating another job',async()=>{
        await expect(service.codexConnector(actor)).resolves.toEqual({state:'missing'});
        const buildId='22222222-2222-4222-8222-222222222222';
        mocks.pool.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:buildId,targets:['darwin-arm64']}]});
        await expect(service.codexConnector(actor)).resolves.toEqual({state:'building',buildId,targets:['darwin-arm64']});
        expect(enqueue).not.toHaveBeenCalled();expect(getPackage).not.toHaveBeenCalled();
        expect(mocks.pool.query.mock.calls.at(-1)?.[1]).toEqual([fixed.url,fixed.commit,fixed.subdirectory,fixed.entrypoint]);
    });
    it('Readiness checks the current immutable published package rather than trusting a metadata label',async()=>{
        const value=publication();value.config!.extra!.runtimeArtifacts=[{target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:100,filesCount:1,entrypoint:'plugin.mjs'}];
        const pkg=buildPackage({id:'plugin-codex',kind:'plugin',name:'Codex fixture',version:1},[],new Date().toISOString(),value.config);
        mocks.pool.query.mockResolvedValue({rows:[{id:pkg.plugin.id,version:1}]});getPackage.mockResolvedValue(pkg);
        await expect(service.codexConnector(actor)).resolves.toEqual({state:'ready',targets:['darwin-arm64']});
        expect(getPackage).toHaveBeenCalledWith(pkg.plugin.id,1);
        getPackage.mockResolvedValue({...pkg,manifest:{...pkg.manifest,sha256:'b'.repeat(64)}});
        await expect(service.codexConnector(actor)).resolves.toEqual({state:'conflict'});
    });
    it('Ambiguous published supplies or duplicate active fixed builds are conflicts, not another automatic build',async()=>{
        mocks.pool.query.mockResolvedValueOnce({rows:[{id:'first',version:1},{id:'second',version:1}]});
        await expect(service.codexConnector(actor)).resolves.toEqual({state:'conflict'});
        mocks.pool.query.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'first'},{id:'second'}]});
        await expect(service.codexConnector(actor)).resolves.toEqual({state:'conflict'});
        expect(enqueue).not.toHaveBeenCalled();expect(getPackage).not.toHaveBeenCalled();
    });
    it('Revoked main role during read-only readiness prevents even a stale missing response',async()=>{
        claims.mockResolvedValueOnce({userRoles:['Главный админ']}).mockResolvedValueOnce({userRoles:[]});
        await expect(service.codexConnector(actor)).rejects.toHaveProperty('status',403);expect(enqueue).not.toHaveBeenCalled();
    });
});
