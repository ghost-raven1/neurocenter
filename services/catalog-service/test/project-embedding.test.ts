import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {ProjectEmbeddingRepository,initialGeneration} from '../src/models/project-embedding.repository';
import {assertProjectEmbeddingModel,projectEmbeddingPin} from '../src/models/project-embedding.validation';

const descriptor={description:'Текст',runtime:'ollama' as const,capability:'embedding' as const,model:'fixture:1',manifestSha256:'a'.repeat(64),dimension:2560,source:'builtin' as const};
const card={id:'model-fixture',name:'Модель',descriptor,revision:1,created_at:'2026-10-20T00:00:00Z',updated_at:'2026-10-20T00:00:00Z'};
const model={...descriptor,id:card.id,name:card.name,revision:1,createdAt:'now',updatedAt:'now'};
const query=vi.fn(),release=vi.fn(),authorize=vi.fn();
const pool={query,connect:async()=>({query,release})} as unknown as Pool;
let stored:Record<string,unknown>|undefined;
const selected=(dimension=2560)=>({project_id:'prj-own',revision:7,model_id:card.id,model_pin:projectEmbeddingPin({...model,dimension}),dimension,
    active_generation:'3aec993b-e5b7-4dfb-a2f0-b732373f4834',active_snapshot:'b'.repeat(64),data_revision:11});
beforeEach(()=>{
    vi.resetAllMocks();stored=selected();authorize.mockResolvedValue(undefined);
    query.mockImplementation(async(sql:string,params:unknown[]=[])=>{
        if(sql.startsWith('SELECT id FROM projects'))return {rows:[{id:'prj-own'}]};
        if(sql.startsWith('SELECT * FROM project_embedding_settings'))return {rows:stored?[stored]:[]};
        if(sql.startsWith('SELECT v.model_id'))return {rows:[{...card,descriptor:{...descriptor,dimension:stored?.dimension??2560},archived_at:null}]};
        if(sql.startsWith('SELECT 1 FROM project_models'))return {rows:[{}]};
        if(sql.startsWith('INSERT INTO project_embedding_settings')){stored={...stored,project_id:params[0],revision:params[1],model_id:null,model_pin:null,dimension:null};return {rows:[stored]};}
        return {rows:[]};
    });
});
describe('Проектная модель и authoritative generation',()=>{
    it.each([1,3,2560,16000])('Размерность %i принадлежит выбранному проекту, глобального default нет',async dimension=>{
        stored=selected(dimension);expect(await new ProjectEmbeddingRepository(pool).read('prj-own')).toMatchObject({expectedDimension:dimension,profile:{dimension},activeGeneration:stored.active_generation,dataRevision:11});
    });
    it('Смена head и catalog-only archive сохраняют историческую модель действующего поколения',async()=>{
        const base=query.getMockImplementation()!;query.mockImplementation(async(sql:string,params:unknown[])=>{
            if(sql.startsWith('SELECT v.model_id'))return {rows:[{...card,archived_at:'2026-10-20T00:01:00Z'}]};return base(sql,params);
        });
        const value=await new ProjectEmbeddingRepository(pool).read('prj-own');expect(value.blocker).toBeUndefined();expect(value.model?.manifestSha256).toBe(descriptor.manifestSha256);
        expect(query.mock.calls.some(([sql])=>sql.startsWith('SELECT * FROM model_catalog'))).toBe(false);
    });
    it.each(['missing-history','assignment','corrupt-pin'])('Повреждённый контекст %s не переключает модель молча',async scenario=>{
        if(scenario==='corrupt-pin')stored!.model_pin='e'.repeat(64);
        const base=query.getMockImplementation()!;query.mockImplementation(async(sql:string,params:unknown[])=>{
            if(scenario==='missing-history'&&sql.startsWith('SELECT v.model_id')||scenario==='assignment'&&sql.startsWith('SELECT 1 FROM project_models'))return {rows:[]};return base(sql,params);
        });
        const value=await new ProjectEmbeddingRepository(pool).read('prj-own');expect(value.blocker).toEqual(expect.any(String));expect(value.modelPin).toBe(stored!.model_pin);
    });
    it('Пустой проект не выдумывает 2560 или выбранную модель',async()=>{
        stored=undefined;expect(await new ProjectEmbeddingRepository(pool).read('prj-own')).toMatchObject({revision:0,expectedDimension:0,model:null,profile:null,activeGeneration:initialGeneration('prj-own')});
    });
    it('Явная очистка сохраняет существующее поколение и снимок, увеличивая только selection revision',async()=>{
        const before={...stored};expect(await new ProjectEmbeddingRepository(pool).clear('prj-own',7,'admin@example.test',authorize)).toMatchObject({revision:8,model:null,profile:null,
            activeGeneration:before.active_generation,activeSnapshot:before.active_snapshot,dataRevision:11});expect(authorize).toHaveBeenCalledOnce();
    });
    it('Потерянный ACK очистки идемпотентен, второй аудит и ревизия не создаются',async()=>{
        const repo=new ProjectEmbeddingRepository(pool);await repo.clear('prj-own',7,'admin@example.test',authorize);query.mockClear();
        expect((await repo.clear('prj-own',7,'admin@example.test',authorize)).revision).toBe(8);expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO security_events'))).toBe(false);
    });
    it('CAS и повторная проверка прав выполняются до очистки действующего выбора',async()=>{
        const repo=new ProjectEmbeddingRepository(pool);await expect(repo.clear('prj-own',6,'admin@example.test',authorize)).rejects.toMatchObject({status:409});
        authorize.mockRejectedValue(new Error('Доступ отозван'));await expect(repo.clear('prj-own',7,'admin@example.test',authorize)).rejects.toThrow('Доступ отозван');
        expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO project_embedding_settings'))).toBe(false);
    });
    it('Сбой аудита не коммитит очистку',async()=>{
        const base=query.getMockImplementation()!;query.mockImplementation(async(sql:string,params:unknown[])=>{if(sql.startsWith('INSERT INTO security_events'))throw Error('Аудит недоступен');return base(sql,params);});
        await expect(new ProjectEmbeddingRepository(pool).clear('prj-own',7,'admin@example.test',authorize)).rejects.toThrow('Аудит недоступен');
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
    });
    it('Технический pin не зависит от оформления, но меняется с реальной моделью',()=>{
        expect(projectEmbeddingPin(model)).toBe(projectEmbeddingPin({...model,name:'Имя',description:'Описание',revision:9}));
        expect(projectEmbeddingPin(model)).not.toBe(projectEmbeddingPin({...model,manifestSha256:'b'.repeat(64)}));
        for(const dimension of [0,16001])expect(()=>assertProjectEmbeddingModel({...model,dimension},dimension)).toThrow();
    });
});
