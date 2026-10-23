import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {validateAsset} from '@neurocenter/asset-contract';
import type {AccessDb} from '../src/access/access-db';
import type {BuildRow} from '../src/package-build/package-build.model';
import {BuildCancelledError} from '../src/package-build/build-cancellation';

const mocks=vi.hoisted(()=>({builds:true,catalog:true,featureServiceAvailable:true,featureError:undefined as Error|undefined,built:vi.fn(),connect:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({connect:mocks.connect})}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async(keys:readonly string[])=>{
    if(mocks.featureError)throw mocks.featureError;
    if(!mocks.featureServiceAvailable)throw new ServiceUnavailableException('Не удалось проверить доступность функции.');
    if(keys.includes('tool_builds')&&!mocks.builds)throw new ForbiddenException('Функция «Сборка инструментов» выключена.');
    if(keys.includes('tool_catalog')&&!mocks.catalog)throw new ForbiddenException('Функция «Каталог инструментов» выключена.');
})}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../src/package-build/build-skill',()=>({buildSkillAsset:mocks.built}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const actor={email:'main@example.test',activeRole:'Главный админ'};
const asset=validateAsset({schemaVersion:1,id:'skill-auth-regression',kind:'skill',version:'source-v1',source:{type:'git',repository:'https://github.com/fixture/skills',commit:'a'.repeat(40)},license:{spdx:'NOASSERTION'},compatibility:{packageFormat:5},card:{path:'common',slug:'auth-skill',name:'Auth skill',body:'Original instruction',meta:{description:'Owned authorization fixture'},resources:[]},delivery:{type:'inline'}});
const files=[{path:'SKILL.md',content:'---\nname: auth-skill\ndescription: Owned authorization fixture\n---\n\nOriginal instruction'}];
const settled=<T>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
afterEach(()=>vi.clearAllMocks());

function fixture(path:'build'|'import',rollbackFails=false){
    mocks.builds=true;mocks.catalog=true;mocks.featureServiceAvailable=true;mocks.featureError=undefined;
    const state={main:true},events:string[]=[],locked=deferred(),resume=deferred(),release=vi.fn();
    const row:BuildRow={id:randomUUID(),request_key:randomUUID(),request_hash:'auth-fixture',actor:actor.email,state:'RUNNING',percent:0,message:'Owned fixture',result:null,error:null,created_at:'then',updated_at:'then',config:{kind:'skill',name:'Auth skill',description:'Owned fixture',tags:[],targets:[],source:{type:'files',entrypoint:'SKILL.md',files}}};
    const query=vi.fn(async(sql:string)=>{
        events.push(sql);
        if(sql==='ROLLBACK'&&rollbackFails)throw Error('Owned rollback ACK lost');
        if(sql.includes('EXTRACT(EPOCH'))return {rows:[{lock_ms:'0',statement_ms:'0'}]};
        if(sql.startsWith('SELECT is_main_admin'))return {rows:[{is_main_admin:state.main,enabled:true}]};
        if(sql.includes('pg_advisory_xact_lock')){locked.resolve();await resume.promise;}
        return {rows:[]};
    });
    const lease={query,release},sources={prepareLocalSkill:vi.fn(async()=>({asset})),publishLocalSkill:vi.fn(async()=>{events.push('native skill');return {id:'common/auth-skill',version:1};}),recordLocalSkill:vi.fn(async()=>{events.push('source receipt');return {assetId:asset.id,sourceVersion:asset.version,sourceSha256:'a'.repeat(64)};})};
    const repository={progress:vi.fn(async()=>undefined),beginPublication:vi.fn(async(_id:string,_lease:unknown,authorize:()=>Promise<void>)=>{await authorize();events.push('committed fence');}),completeWithPublication:vi.fn(async()=>{events.push('build result');})};
    mocks.connect.mockResolvedValue(lease);mocks.built.mockResolvedValue({asset,sourceFile:'/unused-owned-skill.json'});
    const service=new PackageBuildService({claims:async()=>({userRoles:state.main?['Главный админ']:[]})} as unknown as AccessDb,{} as never,{} as never,sources as never);
    Object.assign(service,{lease,repository,releaseLease:(destroy?:boolean)=>release(destroy),scheduleOwnershipRetry:vi.fn(),notifySkillPublication:vi.fn()});
    const run=()=>path==='build'?(service as unknown as {executeSkill(row:BuildRow,stage:string):Promise<unknown>}).executeSkill(row,'/unused-owned-stage'):service.importAsset(actor,{requestKey:row.request_key,asset});
    return {run,service,row,state,query,events,sources,repository,lease,release,locked:locked.promise,resume:resume.resolve};
}
async function afterAssetWait(f:ReturnType<typeof fixture>,change:()=>void){
    const pending=settled(f.run());
    try{
        await Promise.race([f.locked,pending.then(()=>{throw Error('Publication finished before the controlled asset wait');})]);
        change();f.resume();return await pending;
    }finally{f.resume();await pending;}
}

describe('Skill packaging and public skill import reauthorize after the asset wait',()=>{
    for(const path of ['build','import'] as const){
        it.each(['main-role','tool-builds'] as const)(path+' rejects revoked %s before any native side effect',async revoke=>{
            const f=fixture(path),original=JSON.stringify(f.row.config);
            const result=await afterAssetWait(f,()=>{if(revoke==='main-role')f.state.main=false;else mocks.builds=false;});
            expect(mocks.catalog).toBe(true);expect(f.sources.publishLocalSkill).not.toHaveBeenCalled();
            expect(f.sources.recordLocalSkill).not.toHaveBeenCalled();expect(f.repository.completeWithPublication).not.toHaveBeenCalled();expect(f.events).not.toContain('COMMIT');expect(f.events.at(-1)).toBe('ROLLBACK');
            expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({status:403});expect(JSON.stringify(f.row.config)).toBe(original);
        });
        it(path+' healthy control publishes and commits exactly once after the same wait',async()=>{
            const f=fixture(path),result=await afterAssetWait(f,()=>undefined);
            expect(result.ok).toBe(true);expect(f.sources.publishLocalSkill).toHaveBeenCalledOnce();expect(f.sources.recordLocalSkill).toHaveBeenCalledOnce();expect(f.events.filter(value=>value==='COMMIT')).toHaveLength(1);expect(f.events).not.toContain('ROLLBACK');
            const roleLock=f.events.findIndex(sql=>sql.startsWith('SELECT is_main_admin')&&sql.endsWith('FOR SHARE'));
            expect(roleLock).toBeGreaterThan(f.events.findIndex(sql=>sql.includes('pg_advisory_xact_lock')));expect(roleLock).toBeLessThan(f.events.indexOf('native skill'));
            expect(f.query).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE'),[actor.email]);
        });
        it(path+' rejects feature verification 503 after the asset wait before native dispatch',async()=>{
            const f=fixture(path),result=await afterAssetWait(f,()=>{mocks.featureServiceAvailable=false;});
            expect(f.state.main).toBe(true);expect(mocks.builds).toBe(true);expect(mocks.catalog).toBe(true);
            expect(f.sources.publishLocalSkill).not.toHaveBeenCalled();expect(f.sources.recordLocalSkill).not.toHaveBeenCalled();expect(f.repository.completeWithPublication).not.toHaveBeenCalled();
            expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toBeInstanceOf(ServiceUnavailableException);expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.events).not.toContain('COMMIT');
        });
        it(path+' does not commit a successful SQL receipt when tool_builds is disabled during native dispatch',async()=>{
            const f=fixture(path);f.sources.publishLocalSkill.mockImplementation(async()=>{mocks.builds=false;return {id:'common/auth-skill',version:1};});
            const result=await afterAssetWait(f,()=>undefined);
            expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({status:403});
            expect(f.sources.publishLocalSkill).toHaveBeenCalledOnce();expect(f.sources.recordLocalSkill).not.toHaveBeenCalled();expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.events).not.toContain('COMMIT');
        });
        it(path+' rechecks tool_builds after the source receipt await before COMMIT',async()=>{
            const f=fixture(path);f.sources.recordLocalSkill.mockImplementation(async()=>{mocks.builds=false;return {assetId:asset.id,sourceVersion:asset.version,sourceSha256:'a'.repeat(64)};});
            const result=await afterAssetWait(f,()=>undefined);
            expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({status:403});expect(f.sources.recordLocalSkill).toHaveBeenCalledOnce();expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.events).not.toContain('COMMIT');
        });
        it.each([403,503])(path+' retains the original pre-native %s and discards SQL ownership when rollback is unconfirmed',async status=>{
            const primary=status===403?new ForbiddenException('Функция «Сборка инструментов» выключена.'):new ServiceUnavailableException('Проверка флагов недоступна.');
            const f=fixture(path,true),result=await afterAssetWait(f,()=>{mocks.featureError=primary;});
            expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toBe(primary);
            expect(f.release).toHaveBeenCalledExactlyOnceWith(true);if(path==='build')expect((f.service as unknown as {lease?:unknown}).lease).toBeUndefined();
            expect(f.sources.publishLocalSkill).not.toHaveBeenCalled();expect(f.sources.recordLocalSkill).not.toHaveBeenCalled();expect(f.repository.completeWithPublication).not.toHaveBeenCalled();expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.events).not.toContain('COMMIT');
        });
    }
    it('A worker lease lost during the asset wait cannot dispatch a native skill',async()=>{
        const f=fixture('build'),result=await afterAssetWait(f,()=>{Object.assign(f.service,{lease:undefined});});
        expect(f.sources.publishLocalSkill).not.toHaveBeenCalled();expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({status:503});expect(f.events.at(-1)).toBe('ROLLBACK');
    });
    it('Pre-fence cancellation still prevents both BEGIN and a native write',async()=>{
        const f=fixture('build');f.repository.beginPublication.mockRejectedValue(new BuildCancelledError());
        await expect(f.run()).rejects.toBeInstanceOf(BuildCancelledError);expect(f.sources.publishLocalSkill).not.toHaveBeenCalled();expect(f.events).not.toContain('BEGIN');
    });
});
