import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {FsSkillsStorage} from '../src/storage/fs-skills-storage';
import {serializeSkillFile} from '../src/storage/frontmatter';
import {versionRelative} from '../src/storage/skill-versions';
import {archiveImportedSkill,importedSkillSnapshot} from '../src/skills/asset-import';
import {inspectLegacySkill,retireLegacySkill} from '../src/skills/legacy-retirement';
import type {ISkillMeta} from '../src/skills/skills.model';

describe('Audited legacy retirement retains actual original bytes',()=>{
    let root:string,storage:FsSkillsStorage;
    const actor='operator@example.test';
    async function fixture(id='project-prj-lancedb/code-review-helper'){
        const project=id.startsWith('project-'),meta:ISkillMeta={name:'Legacy',slug:id.split('/')[1],scope:project?'project':'common',...(project?{projectId:'prj-lancedb'}:{}),
            version:2,owner:'platform',updatedAt:'2026-10-01T00:00:00Z',tags:[],mcp:['unknown-original'],plugins:[],history:[{version:1,at:'2026-09-01',author:'platform'},{version:2,at:'2026-10-01',author:'platform'}]};
        const resources=[{path:'assets/original.bin',content:Buffer.from([0,1,2,254,255]).toString('base64'),encoding:'base64' as const}],raw=serializeSkillFile(meta,'# Original\nKeep exactly.\n',resources)+'\n';
        await fs.mkdir(path.join(root,id.split('/')[0]),{recursive:true});await fs.writeFile(path.join(root,id+'.md'),raw);
        const file=await storage.readSkill(id);return {id,file,raw,expected:{...importedSkillSnapshot(file),source:await storage.sourceReceipt(id)}};
    }
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-legacy-retirement-'));storage=new FsSkillsStorage(root,undefined,async()=>{});await storage.init();});
    afterEach(async()=>{await storage.onModuleDestroy();await fs.rm(root,{recursive:true,force:true});});
    it('Can quarantine an orphan without inventing a replacement project',async()=>{
        const f=await fixture(),{bytes,sha256,version,resources}=f.expected.source;
        const result=await retireLegacySkill(storage,f.id,{...f.expected,source:{resources,bytes,version,sha256}},actor,randomUUID());
        expect(result.archivedAt).toBeTruthy();
    });
    it.each(['common/memory','common/jest-test','project-prj-lancedb/code-review-helper'])('Operator retirement keeps current bytes/resources/history for %s and exact retry is idempotent',async id=>{
        const f=await fixture(id),key=randomUUID(),result=await retireLegacySkill(storage,id,f.expected,actor,key);
        expect(result).toMatchObject({version:3,preservedSource:f.expected.source,missingVersions:[1]});
        expect((await storage.readSkill(id)).meta.projectId).toBe(f.file.meta.projectId);
        expect(await fs.readFile(path.join(root,versionRelative(id,f.file.meta,2)),'utf8')).toBe(f.raw);
        expect(createHash('sha256').update(f.raw).digest('hex')).toBe(result.preservedSource.sha256);
        expect((await retireLegacySkill(storage,id,f.expected,actor,key)).version).toBe(3);
        await expect(storage.readSkill(id,1)).rejects.toMatchObject({status:404});
    });
    it('Rejects edited or corrupt original receipts and arbitrary paths before writing',async()=>{
        const f=await fixture(),write=vi.spyOn(storage,'writeSkill');
        await expect(retireLegacySkill(storage,f.id,{...f.expected,source:{...f.expected.source,sha256:'0'.repeat(64)}},actor,randomUUID())).rejects.toMatchObject({status:409});
        for(const id of ['../outside','common/unrelated','project-real/code-review-helper'])await expect(retireLegacySkill(storage,id,f.expected,actor,randomUUID())).rejects.toMatchObject({status:400});
        await fs.appendFile(path.join(root,f.id+'.md'),'Changed by user');
        await expect(retireLegacySkill(storage,f.id,f.expected,actor,randomUUID())).rejects.toMatchObject({status:409});expect(write).not.toHaveBeenCalled();
    });
    it('Normal catalog archive still cannot mutate a project orphan through the common-skill API',async()=>{
        const f=await fixture();await expect(archiveImportedSkill(storage,f.id,f.expected,actor,false,randomUUID())).rejects.toMatchObject({status:400});
        expect((await inspectLegacySkill(storage,f.id)).missingVersions).toEqual([1]);
    });
});
