vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {AccessDb} from '../src/access/access-db';
import type {BuildRow} from '../src/package-build/package-build.model';
import {PUBLICATION_DEADLINE_MESSAGE} from '../src/package-build/publication-deadline';

const mocks=vi.hoisted(()=>({releaseDisk:vi.fn(),built:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>mocks.releaseDisk}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../src/package-build/build-skill',()=>({buildSkillAsset:mocks.built}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const files=[{path:'SKILL.md',content:'---\nname: deadline-skill\ndescription: Owned publication fixture\n---\n\nOriginal instruction'}];
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(failure?:Error,rollbackFails=false){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-publication-deadline-'));roots.push(root);
    const events:string[]=[],discard=vi.fn(),row:BuildRow={id:randomUUID(),request_key:randomUUID(),request_hash:'owned-fixture',actor:'main@example.test',state:'RUNNING',percent:0,message:'Preparing owned fixture',result:null,error:null,created_at:'then',updated_at:'then',config:{kind:'skill',name:'Deadline skill',description:'Owned fixture',tags:[],targets:[],source:{type:'files',entrypoint:'SKILL.md',files}}};
    const query=vi.fn(async(sql:string)=>{
        events.push(sql);
        if(sql.includes('EXTRACT(EPOCH'))return {rows:[{lock_ms:'0',statement_ms:'0'}]};
        if(sql.includes('pg_advisory_xact_lock')&&failure)throw failure;
        if(sql==='ROLLBACK'&&rollbackFails)throw Error('Rollback ACK lost');
        return {rows:[]};
    });
    const lease={query} as unknown as PoolClient,repository={beginPublication:vi.fn(async()=>{events.push('committed fence');}),progress:vi.fn(async()=>undefined),completeWithPublication:vi.fn(async()=>{events.push('build success');})};
    const sources={prepareLocalSkill:vi.fn(async()=>({})),publishLocalSkill:vi.fn(async()=>{events.push('native skill');return {id:'common/deadline-skill',version:1};}),recordLocalSkill:vi.fn(async()=>({assetId:'skill-owned',sourceVersion:'v1',sourceSha256:'a'.repeat(64)}))};
    mocks.built.mockResolvedValue({asset:{card:{slug:'deadline-skill',name:'Deadline skill'}},sourceFile:path.join(root,'source.json')});
    const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as unknown as AccessDb,{} as never,{} as never,sources as never);
    Object.assign(service,{lease,repository,discardLease:discard,notifySkillPublication:vi.fn()});
    return {root,row,service,lease,repository,sources,query,events,discard};
}

describe('Skill packaging configures its own SQL transaction before native publication',()=>{
    it('Sets transaction deadlines after the committed fence and BEGIN, before the first lock/native effect',async()=>{
        const f=await fixture();await (f.service as unknown as {execute(row:BuildRow,root:string):Promise<void>}).execute(f.row,f.root);
        const settings=f.events.findIndex(sql=>sql.includes('set_config'));
        expect(settings).toBeGreaterThan(f.events.indexOf('BEGIN'));expect(f.events.indexOf('BEGIN')).toBeGreaterThan(f.events.indexOf('committed fence'));
        expect(settings).toBeLessThan(f.events.findIndex(sql=>sql.includes('pg_advisory_xact_lock')));expect(settings).toBeLessThan(f.events.indexOf('native skill'));
        expect(f.repository.completeWithPublication).toHaveBeenCalledOnce();expect(f.events.at(-1)).toBe('COMMIT');expect(f.discard).not.toHaveBeenCalled();
    });
    it.each(['55P03','57014'])('SQL %s produces actionable FAILED and releases only its stage while retaining the exact source',async code=>{
        const primary=Object.assign(Error('Synthetic SQL wait ended'),{code}),f=await fixture(primary),original=JSON.stringify(f.row.config);
        await (f.service as unknown as {execute(row:BuildRow,root:string):Promise<void>}).execute(f.row,f.root);
        expect(f.repository.progress).toHaveBeenLastCalledWith(f.row.id,'FAILED',0,PUBLICATION_DEADLINE_MESSAGE,undefined,PUBLICATION_DEADLINE_MESSAGE);
        expect(f.sources.publishLocalSkill).not.toHaveBeenCalled();expect(f.repository.completeWithPublication).not.toHaveBeenCalled();
        expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.discard).not.toHaveBeenCalled();expect(await fs.readdir(f.root)).toEqual([]);expect(JSON.stringify(f.row.config)).toBe(original);expect(mocks.releaseDisk).toHaveBeenCalledOnce();
    });
    it('A timeout with unknown rollback discards its lease and preserves the primary error',async()=>{
        const primary=Object.assign(Error('Synthetic SQL wait ended'),{code:'55P03'}),f=await fixture(primary,true);
        await expect((f.service as unknown as {executeSkill(row:BuildRow,stage:string):Promise<void>}).executeSkill(f.row,f.root)).rejects.toBe(primary);
        expect(f.discard).toHaveBeenCalledExactlyOnceWith(f.lease);expect(f.sources.publishLocalSkill).not.toHaveBeenCalled();expect(f.events).not.toContain('COMMIT');
    });
});
