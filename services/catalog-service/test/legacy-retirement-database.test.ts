import 'reflect-metadata';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ForbiddenException,ServiceUnavailableException,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {Request} from 'express';
import {LEGACY_DEMO_SKILLS,LEGACY_DEMO_REFS} from '../../shared/legacy-demo-retirement.cjs';
import {FsSkillsStorage} from '../../skills-service/src/storage/fs-skills-storage';
import {SkillsService} from '../../skills-service/src/skills/skills.service';
import {SkillAssetImportController} from '../../skills-service/src/skills/asset-import.controller';
import {LegacyRetirementService} from '../src/asset-sources/legacy-retirement.service';
import {LegacyRetirementController} from '../src/asset-sources/legacy-retirement.controller';
import {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import {databaseFixture,actor} from './asset-import-db.fixture';

describe('Fixed-scope legacy migration — actual FS bytes + isolated PostgreSQL + HTTP',()=>{
    let f:Awaited<ReturnType<typeof databaseFixture>>,storage:FsSkillsStorage,skills:SkillsService,internal:SkillAssetImportController,retirement:LegacyRetirementService,app:INestApplication,base:string,loseAck:boolean;
    const token='legacy-retirement-fixture-token';
    const headers=(email=actor,role='Главный админ')=>({'content-type':'application/json','x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole:role}))});
    const post=async(route:string,body:unknown,email=actor,role='Главный админ')=>{const response=await fetch(base+'/api/asset-management/legacy-retirement/'+route,{method:'POST',headers:headers(email,role),body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
    const preview=async()=>{const p=await post('preview',{});expect(p.status).toBe(201);return p.body;};
    const input=(p:any)=>({previewId:p.previewId,expectedDigest:p.digest,requestKey:randomUUID()});
    beforeEach(async()=>{
        f=await databaseFixture();loseAck=false;vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);
        storage=new FsSkillsStorage(path.join(f.root,'skills'),undefined,async()=>{});await storage.init();skills=new SkillsService(storage);internal=new SkillAssetImportController(skills);
        for(const entry of LEGACY_DEMO_SKILLS){
            const raw=await fs.readFile(new URL('../../skills-service/test/fixtures/legacy-retirement/'+entry.id+'.md',import.meta.url));
            expect(createHash('sha256').update(raw).digest('hex')).toBe(entry.sha256);
            await fs.mkdir(path.join(storage.baseDir,path.dirname(entry.id)),{recursive:true});await fs.writeFile(path.join(storage.baseDir,entry.id+'.md'),raw);
        }
        await f.pool.query("INSERT INTO projects VALUES('prj-dossier-ko','Dossier');");
        for(const ref of LEGACY_DEMO_REFS)await f.pool.query("INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,pin_origin) VALUES($1,$2,$3,$4,'unresolved')",[ref.projectId,ref.id,ref.kind,actor]);
        const source={pool:f.pool,catalogReady:async()=>{},actor:async(req:Request)=>{const a=JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'])));if(a.activeRole!=='Главный админ')throw new ForbiddenException();return a.email;}};
        retirement=new LegacyRetirementService(source as never);await retirement.onModuleInit();
        vi.spyOn(retirement['skills'],'call').mockImplementation(async(method,body:any)=>{
            const request={headers:{'x-neurocenter-internal':token}} as Request;
            const result=method==='legacy-inspect'?await internal.legacyInspect(request,body):await internal.legacyRetire(request,body);
            if(loseAck&&method==='legacy-retire'){loseAck=false;throw new ServiceUnavailableException('fixture lost FS ACK');}return result as never;
        });
        Reflect.defineMetadata('design:paramtypes',[AssetSourcesService,LegacyRetirementService],LegacyRetirementController);class FixtureModule{}
        app=await NestFactory.create({module:FixtureModule,controllers:[LegacyRetirementController],providers:[{provide:AssetSourcesService,useValue:source},{provide:LegacyRetirementService,useValue:retirement}]},{logger:false});
        app.useGlobalFilters({catch(error:any,host:any){host.switchToHttp().getResponse().status(error.getStatus?.()??500).json({message:error.message});}});
        await app.listen(0,'127.0.0.1');base=await app.getUrl();
    });
    afterEach(async()=>{await app?.close();await storage?.onModuleDestroy();vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();});
    it('Archives exactly the three audited originals and quarantines unresolved rows; retry preserves exact bytes and one receipt',async()=>{
        const p=await preview(),before=(await f.pool.query('SELECT * FROM project_assets ORDER BY asset_id')).rows;
        expect(p.skills.filter((i:any)=>i.eligible)).toHaveLength(3);expect(p.refs).toHaveLength(3);const body=input(p),done=await post('apply',body);
        expect(done.status,JSON.stringify(done.body)).toBe(201);expect(done.body).toMatchObject({state:'SUCCEEDED',quarantinedRefs:3,projectsDeleted:0,historyPurged:false});
        expect((await post('apply',body)).body).toEqual(done.body);
        for(const entry of LEGACY_DEMO_SKILLS){const file=await skills.getSkill(entry.id);expect(file.meta.version).toBe(entry.version+1);expect(file.meta.archivedAt).toBeTruthy();expect((await storage.sourceReceipt(entry.id,entry.version)).sha256).toBe(entry.sha256);}
        expect(await skills.listSkills({})).toEqual([]);expect((await f.pool.query('SELECT * FROM project_assets')).rowCount).toBe(0);
        const retained=(await f.pool.query('SELECT original_record FROM legacy_retired_project_assets ORDER BY asset_id')).rows.map(r=>r.original_record);
        expect(retained).toEqual(JSON.parse(JSON.stringify(before)));expect((await f.pool.query('SELECT * FROM projects')).rowCount).toBe(1);
        expect((await f.pool.query("SELECT * FROM security_events WHERE action='asset.legacy.retire'")).rowCount).toBe(1);
        await expect(skills.getSkill('common/jest-test',1)).rejects.toMatchObject({status:404});
    });
    it('Lost FS acknowledgement resumes the same operation without a second archive version',async()=>{
        const p=await preview(),body=input(p);loseAck=true;expect((await post('apply',body)).status).toBe(503);
        expect((await post('apply',body)).body.state).toBe('SUCCEEDED');expect((await skills.getSkill('common/memory')).meta.version).toBe(3);
        expect((await f.pool.query('SELECT * FROM legacy_retired_project_assets')).rowCount).toBe(3);
    });
    it('SQL/audit rollback leaves original assignments intact and retry finishes the durable FS partial result',async()=>{
        const p=await preview(),body=input(p);await f.pool.query(`CREATE FUNCTION fail_retirement_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='asset.legacy.retire' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER fail_retirement_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION fail_retirement_audit();`);
        expect((await post('apply',body)).body.state).toBe('PARTIAL');expect((await f.pool.query('SELECT * FROM project_assets')).rowCount).toBe(3);
        expect((await f.pool.query('SELECT * FROM legacy_retired_project_assets')).rowCount).toBe(0);
        await f.pool.query('DROP TRIGGER fail_retirement_audit ON security_events');expect((await post('apply',body)).body.state).toBe('SUCCEEDED');
        expect((await skills.getSkill('common/memory')).meta.version).toBe(3);
    });
    it('A lost COMMIT acknowledgement cannot replace durable success with PARTIAL or strand removed refs',async()=>{
        const p=await preview(),body=input(p),connect=f.pool.connect.bind(f.pool);let injected=false;
        const originalSource=retirement['source'];
        const proxy={...originalSource,pool:{query:f.pool.query.bind(f.pool),connect:async()=>{
            const client=await connect();let completed=false;
            return {query:async(sql:string,values?:unknown[])=>{
                const result=await client.query(sql,values);if(sql.startsWith("UPDATE legacy_retirement_operations SET state='SUCCEEDED'"))completed=true;
                if(sql==='COMMIT'&&completed&&!injected){injected=true;throw Error('fixture lost COMMIT ACK after actual commit');}return result;
            },release:()=>client.release()};
        }}};
        Object.defineProperty(retirement,'source',{value:proxy,configurable:true});
        expect((await post('apply',body)).body.state).toBe('SUCCEEDED');expect(injected).toBe(true);
        expect((await f.pool.query('SELECT state FROM legacy_retirement_operations WHERE id=$1',[p.previewId])).rows[0].state).toBe('SUCCEEDED');
        expect((await f.pool.query('SELECT * FROM project_assets')).rowCount).toBe(0);expect((await post('apply',body)).body.state).toBe('SUCCEEDED');
        expect((await skills.getSkill('common/memory')).meta.version).toBe(3);
    });
    it('Arbitrary input, changed source, a reappearing project, repaired refs and revoked rights fail before any archive',async()=>{
        expect((await post('preview',{path:'../outside'})).status).toBe(400);expect((await post('preview',{},actor,'Разработчик')).status).toBe(403);
        const p=await preview(),body=input(p);await fs.appendFile(path.join(storage.baseDir,'common/jest-test.md'),'User changed source');
        expect((await post('apply',body)).status).toBe(409);expect((await skills.getSkill('common/memory')).meta.archivedAt).toBeUndefined();
        const p2=await preview();await f.pool.query("INSERT INTO projects VALUES('prj-lancedb','New real project');");expect((await post('apply',input(p2))).status).toBe(409);
        expect((await skills.getSkill('common/memory')).meta.archivedAt).toBeUndefined();await f.pool.query("DELETE FROM projects WHERE id='prj-lancedb'");
        const p3=await preview();await f.pool.query("DELETE FROM project_assets WHERE asset_id='rag-index-monitor'");expect((await post('apply',input(p3))).status).toBe(409);
        const p4=await preview();await f.pool.query('UPDATE platform_users SET is_main_admin=false');expect((await post('apply',input(p4))).status).toBe(403);expect((await skills.getSkill('common/memory')).meta.archivedAt).toBeUndefined();
    });
    it('Foreign actor, expired preview, wrong digest and key reuse cannot change the approved scope',async()=>{
        const p=await preview(),body=input(p);expect((await post('apply',body,'other@example.test')).status).toBe(404);
        expect((await post('apply',{...body,expectedDigest:'0'.repeat(64)})).status).toBe(409);expect((await post('apply',{...body,id:'common/unrelated'})).status).toBe(400);
        await f.pool.query("UPDATE legacy_retirement_previews SET expires_at=now()-interval '1 second'");expect((await post('apply',body)).status).toBe(409);
        const next=await preview(),nextBody=input(next);expect((await post('apply',nextBody)).body.state).toBe('SUCCEEDED');const last=await preview();expect((await post('apply',{...input(last),requestKey:nextBody.requestKey})).status).toBe(409);
    });
});
