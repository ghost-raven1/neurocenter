import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CatalogDb} from '../src/catalog/catalog-db';
const io=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query:io.query})}));
describe('Project snapshot CAS exposes head revision independently of nullable head',()=>{
    beforeEach(()=>vi.clearAllMocks());
    it.each([0,7])('Returns actual revision %s while no head is selected',async revision=>{
        io.query.mockResolvedValue({rows:[{id:'project-one',name:'Project',state:'ACTIVE',head_snapshot_id:null,head_revision:String(revision)}]});
        const project=await new CatalogDb('postgresql://isolated').getProject('project-one');expect(project?.head).toBeNull();expect(project?.headRevision).toBe(revision);
    });
    it('Preserves matching top-level and selected head revision',async()=>{
        io.query.mockResolvedValue({rows:[{id:'project-one',name:'Project',state:'ACTIVE',head_snapshot_id:'snapshot-one',head_revision:'11',head_author:'one@example.test',head_snapshot_date:'2026-10-21T00:00:00Z'}]});
        const project=await new CatalogDb('postgresql://isolated').getProject('project-one');expect(project?.headRevision).toBe(11);expect(project?.head?.headRevision).toBe(11);
    });
});
