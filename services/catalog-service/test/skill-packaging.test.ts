import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {assetDigest,serializeAsset,toSkillCreate} from '@neurocenter/asset-contract';
import {FsSkillsStorage} from '../../skills-service/src/storage/fs-skills-storage';
import {SkillsService} from '../../skills-service/src/skills/skills.service';
import {SkillAssetImportController} from '../../skills-service/src/skills/asset-import.controller';
import {LocalSkillIngest} from '../src/asset-sources/local-skill-ingest';
import {buildSkillAsset} from '../src/package-build/build-skill';
import {validateBuildInput,type BuildConfiguration} from '../src/package-build/package-build.model';
import {toolSupplyPlan,createToolSupply} from '../src/package-build/supply-export';
import {reserveSkillDependencies} from '../src/publication/skill-dependency-registry';
import {databaseFixture,actor} from './asset-import-db.fixture';
import * as tar from 'tar';

const content='---\nname: packaged-skill\ndescription: Проверка упаковки\n---\n\n[Правила](references/rules.md)\n';
const files=[{path:'SKILL.md',content},{path:'references/rules.md',content:'Правила'},{path:'scripts/build/helper.py',content:'print("never executed")'},{path:'assets/dist/example.md',content:'Данные'}];
const configuration=()=>({...validateBuildInput({requestKey:randomUUID(),kind:'skill',name:'Помощник',description:'Проверка упаковки',source:{type:'files',entrypoint:'SKILL.md',files}})}) as BuildConfiguration;

describe('Skill packaging — actual native journal, SQL receipts and supply bytes',()=>{
    let fixture:Awaited<ReturnType<typeof databaseFixture>>,storage:FsSkillsStorage,skills:SkillsService,ingest:LocalSkillIngest,loseAck:boolean;
    beforeEach(async()=>{
        fixture=await databaseFixture();vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','skill-package-test-only');vi.stubEnv('RUNTIME_ARTIFACT_DIR',fixture.root);
        storage=new FsSkillsStorage(path.join(fixture.root,'skills'),entries=>reserveSkillDependencies(fixture.pool,{entries}),async()=>undefined);
        skills=new SkillsService(storage);const controller=new SkillAssetImportController(skills);loseAck=false;
        vi.stubGlobal('fetch',async(url:string,options?:RequestInit)=>{
            const request={headers:{'x-neurocenter-internal':(options?.headers as Record<string,string>)?.['x-neurocenter-internal']}} as Request;
            const body=options?.body?JSON.parse(String(options.body)):undefined,method=String(url).split('/').at(-1);
            try{
                const value=method==='preview'?await controller.preview(request,body):method==='inspect'?await controller.inspect(request,body):await controller.publish(request,body);
                if(method==='publish'&&loseAck){loseAck=false;throw new Error('Lost native ACK');}
                return Response.json(value);
            }catch(error){if((error as Error).message==='Lost native ACK')throw error;return Response.json({message:(error as Error).message},{status:(error as {status?:number}).status??500});}
        });
        ingest=new LocalSkillIngest(fixture.pool,fixture.blobs);
    });
    afterEach(async()=>{await storage?.onModuleDestroy();vi.unstubAllGlobals();vi.unstubAllEnvs();await fixture?.dispose();});
    const build=async(config=configuration())=>{
        const stage=await fs.mkdtemp(path.join(fixture.root,'build-'));return buildSkillAsset(config,stage);
    };
    const commit=async(prepared:Awaited<ReturnType<LocalSkillIngest['prepare']>>,rollback=false)=>{
        const client=await fixture.pool.connect();
        try{
            await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:skill:common/packaged-skill']);
            const native=await ingest.publish(prepared,actor),reference=await ingest.record(client,prepared,native,actor);
            if(rollback){await client.query('ROLLBACK');return reference;}await client.query('COMMIT');return reference;
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    it('Publishes SKILL.md and resources without any JS executable; receipt retains the exact source envelope',async()=>{
        const built=await build(),prepared=await ingest.prepare(built.asset,randomUUID(),built.sourceFile),reference=await commit(prepared);
        expect(reference).toEqual({assetId:built.asset.id,sourceVersion:built.asset.version,sourceSha256:assetDigest(serializeAsset(built.asset))});
        const skill=await skills.getSkill('common/packaged-skill');expect(skill.meta.name).toBe('Помощник');expect(skill.meta.version).toBe(1);expect(skill.resources).toHaveLength(3);
        expect(skill.resources?.find(item=>item.path==='assets/dist/example.md')?.content).toBe('Данные');
        const receipt=(await fixture.pool.query('SELECT * FROM asset_source_versions')).rows[0];expect(receipt.asset_kind).toBe('skill');expect(receipt.descriptor).toEqual(built.asset);expect(receipt.blobs).toHaveLength(1);
    });
    it('A lost native ACK recovers the same version under a new durable build request',async()=>{
        const built=await build(),first=await ingest.prepare(built.asset,randomUUID(),built.sourceFile);loseAck=true;
        await expect(ingest.publish(first,actor)).rejects.toThrow('не подтвердил');expect((await skills.getSkill('common/packaged-skill')).meta.version).toBe(1);
        await commit(await ingest.prepare(built.asset,randomUUID(),built.sourceFile));
        expect((await skills.getSkill('common/packaged-skill')).meta.history).toHaveLength(1);expect((await fixture.pool.query('SELECT * FROM asset_source_versions')).rows).toHaveLength(1);
    });
    it('Catalog rollback after the FS commit is recoverable without a duplicate native version or receipt',async()=>{
        const built=await build();await commit(await ingest.prepare(built.asset,randomUUID(),built.sourceFile),true);
        expect((await fixture.pool.query('SELECT * FROM asset_source_versions')).rows).toHaveLength(0);
        await commit(await ingest.prepare(built.asset,randomUUID(),built.sourceFile));expect((await skills.getSkill('common/packaged-skill')).meta.version).toBe(1);
        expect((await fixture.pool.query('SELECT * FROM asset_source_versions')).rows).toHaveLength(1);
    });
    it('An untracked local slug is never silently claimed, even for identical content',async()=>{
        const built=await build();await skills.createSkill(toSkillCreate(built.asset) as never,actor);
        await expect(ingest.prepare(built.asset,randomUUID(),built.sourceFile)).rejects.toThrow('Путь занят локальным');
        expect((await skills.getSkill('common/packaged-skill')).meta.version).toBe(1);
    });
    it('A local edit invalidates the source head and the recovery marker',async()=>{
        const built=await build();await commit(await ingest.prepare(built.asset,randomUUID(),built.sourceFile));
        await skills.updateSkill('common/packaged-skill',{body:'Локальная правка'},actor);
        await expect(ingest.prepare(built.asset,randomUUID(),built.sourceFile)).rejects.toThrow('изменена локально');
        expect((await skills.getSkill('common/packaged-skill')).meta.version).toBe(2);
    });
    it('A concurrent edit between preview and publish is rejected by the existing native CAS',async()=>{
        const built=await build(),prepared=await ingest.prepare(built.asset,randomUUID(),built.sourceFile);
        await skills.createSkill({...toSkillCreate(built.asset),body:'Создан другим пользователем'} as never,actor);
        await expect(commit(prepared)).rejects.toThrow('уже существует');expect((await fixture.pool.query('SELECT * FROM asset_source_receipts')).rows).toHaveLength(0);
    });
    it('A nested wrapper preserves skill-relative links and ignores sibling documentation',async()=>{
        const config=configuration();config.source={type:'files',entrypoint:'archive/root/my-skill/SKILL.md',files:[{path:'archive/README.md',content:'Общее описание'},...files.map(file=>({...file,path:'archive/root/my-skill/'+file.path}))]};
        const built=await build(config);expect((built.asset.card.resources as Array<{path:string}>).map(item=>item.path)).toEqual(['assets/dist/example.md','references/rules.md','scripts/build/helper.py']);
        expect(built.asset.card.slug).toBe('packaged-skill');await commit(await ingest.prepare(built.asset,randomUUID(),built.sourceFile));
    });
    it('Binary resources retain exact bytes using the native base64 encoding through publication and export',async()=>{
        const binary=Buffer.from([137,80,78,71,0,255,128,10]),config=configuration();
        if(config.source.type!=='files')throw new Error('Fixture source');
        config.source.files.push({path:'assets/diagram.png',content:binary.toString('base64'),encoding:'base64'});
        const built=await build(config);await commit(await ingest.prepare(built.asset,randomUUID(),built.sourceFile));
        const saved=(await skills.getSkill('common/packaged-skill')).resources!.find(item=>item.path==='assets/diagram.png')!;
        expect(saved.encoding).toBe('base64');expect(Buffer.from(saved.content,'base64')).toEqual(binary);
        const receipt=(await fixture.pool.query('SELECT * FROM asset_source_versions')).rows[0];expect(receipt.descriptor.card.resources.find((item:{path:string})=>item.path==='assets/diagram.png')).toEqual(saved);
    });
    it('Exported skill supply preserves canonical asset SHA and opaque source bytes; exact reimport is unchanged',async()=>{
        const built=await build();await commit(await ingest.prepare(built.asset,randomUUID(),built.sourceFile));
        const receipt=(await fixture.pool.query('SELECT * FROM asset_source_versions')).rows[0],plan=toolSupplyPlan(receipt);
        expect(plan.asset.kind).toBe('skill');expect(plan.files).toHaveLength(1);
        const result=await createToolSupply(plan,fixture.blobs,new AbortController().signal),chunks:Buffer[]=[];
        try{for await(const chunk of result.stream)chunks.push(chunk);}finally{await result.cleanup();}
        const archive=path.join(fixture.root,'supply.tar.gz'),output=path.join(fixture.root,'output');await fs.writeFile(archive,Buffer.concat(chunks));await fs.mkdir(output);await tar.x({file:archive,cwd:output,strict:true});
        const bytes=await fs.readFile(path.join(output,'asset.json'));expect(assetDigest(bytes)).toBe(receipt.descriptor_sha256);
        const imported=await ingest.prepare(JSON.parse(bytes.toString()),randomUUID());await commit(imported);
        expect((await skills.getSkill('common/packaged-skill')).meta.version).toBe(1);
        expect((await fixture.pool.query('SELECT * FROM asset_source_versions')).rows).toHaveLength(1);
    });
});
