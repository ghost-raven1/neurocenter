import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const {query}=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/database/catalog-schema',()=>({ensureCatalogSchema:vi.fn(async()=>{})}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query,end:vi.fn(),connect:async()=>({query,release:vi.fn()})})}));
import {CatalogDb} from '../src/catalog/catalog-db';

describe('Сохранность путей проектов при перезапуске',()=>{
    beforeEach(()=>{query.mockReset().mockImplementation(async(sql:string)=>String(sql).includes('SELECT COUNT(*)::int AS n FROM project_members')?{rows:[{n:1}],rowCount:1}:{rows:[],rowCount:0});vi.stubEnv('PROJECTS_ROOT','/data/projects');});
    afterEach(()=>vi.unstubAllEnvs());
    it('Production не выводит папку из названия и не обновляет карточку проекта',async()=>{
        vi.stubEnv('NODE_ENV','production');await new CatalogDb('postgresql://test').setup();
        expect(query.mock.calls.some(([sql])=>String(sql).includes('SELECT id, name FROM projects WHERE fs_root_path'))).toBe(false);
        expect(query.mock.calls.some(([sql])=>String(sql).includes('UPDATE projects SET fs_root_path'))).toBe(false);
    });
    it('Локальный seed сохраняет прежнюю загрузку демонстрационных путей',async()=>{
        vi.stubEnv('NODE_ENV','development');await new CatalogDb('postgresql://test').setup();
        expect(query.mock.calls.some(([sql])=>String(sql).includes('SELECT id, name FROM projects WHERE fs_root_path'))).toBe(true);
    });
});
