import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request} from 'express';
import type {AccessDb} from '../src/access/access-db';
import type {CatalogService} from '../src/catalog/catalog.service';
import {ModelsService} from '../src/models/models.service';
import {ProjectEmbeddingService} from '../src/models/project-embedding.service';
import {ProjectEmbeddingController} from '../src/models/project-embedding.controller';
import {allowRequest} from '../src/access/access-policy';

const {query}=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query,connect:async()=>({query,release:vi.fn()})})}));
const email='member@example.test',projectId='prj-owned';
const assigned={email,userRoles:['Админ проекта','Разработчик','Наблюдатель'],projects:[{projectId,projectName:'Мой проект',role:'Админ проекта'}],pluginIds:[],skillPaths:[]};
const claims=vi.fn();
const request=(activeRole='Админ проекта')=>({headers:{'x-neurocenter-internal':'embedding-access-fixture',
    'x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole}))}}) as unknown as Request;
const catalog={ensureSchema:vi.fn(),getProject:vi.fn(async()=>({id:projectId}))};
const modelService=new ModelsService(catalog as unknown as CatalogService,{claims} as unknown as AccessDb);
const service=new ProjectEmbeddingService(modelService),controller=new ProjectEmbeddingController(service);
beforeEach(()=>{
    vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','embedding-access-fixture');vi.resetAllMocks();claims.mockResolvedValue(assigned);
    query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT id FROM projects')?[{id:projectId}]:[]}));
    catalog.getProject.mockResolvedValue({id:projectId});
});
afterEach(()=>vi.unstubAllEnvs());
describe('Права проектного выбора embedding',()=>{
    it.each(['Админ проекта','Разработчик','Наблюдатель'])('Участник %s читает настройку канонического проекта через имя',async role=>{
        expect(await controller.get(request(role),'Мой проект')).toMatchObject({projectId,revision:0,model:null,modelPin:null,profile:null});
        expect(query).toHaveBeenCalledWith('SELECT * FROM project_embedding_settings WHERE project_id=$1',[projectId]);
    });
    it.each(['Разработчик','Наблюдатель'])('Роль %s не меняет выбор',async role=>{
        await expect(controller.update(request(role),projectId,{expectedRevision:0,modelId:null})).rejects.toMatchObject({status:403});expect(query).not.toHaveBeenCalled();
    });
    it('Чужой проект и отозванная роль не читают даже сохранённый pin',async()=>{
        await expect(controller.get(request(),'prj-foreign')).rejects.toMatchObject({status:403});
        claims.mockResolvedValue({...assigned,userRoles:[]});await expect(controller.get(request(),projectId)).rejects.toMatchObject({status:403});
        expect(query).not.toHaveBeenCalled();
    });
    it('Отзыв роли после начальной проверки повторно проверяется в транзакции',async()=>{
        claims.mockResolvedValueOnce(assigned).mockResolvedValue({...assigned,userRoles:[]});
        await expect(controller.update(request(),projectId,{expectedRevision:0,modelId:null})).rejects.toMatchObject({status:403});
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO project_embedding_settings'))).toBe(false);
    });
    it('Граница gateway совпадает: чтение участнику, PATCH только админу проекта',()=>{
        for(const role of assigned.userRoles){
            expect(allowRequest(assigned,role,{method:'GET',path:`/api/projects/${projectId}/embedding`})).toBe(true);
            expect(allowRequest(assigned,role,{method:'PATCH',path:`/api/projects/${projectId}/embedding`})).toBe(role==='Админ проекта');
        }
        expect(allowRequest(assigned,'Админ проекта',{method:'PATCH',path:'/api/projects/prj-foreign/embedding'})).toBe(false);
    });
});
