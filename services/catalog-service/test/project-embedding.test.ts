import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {ProjectEmbeddingRepository} from '../src/models/project-embedding.repository';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';

const descriptor={description:'Текст',runtime:'ollama',capability:'embedding',model:'fixture:1',manifestSha256:'a'.repeat(64),dimension:2560,source:'builtin'};
const card={id:'model-fixture',name:'Модель',descriptor,revision:1,created_at:'2026-10-20T00:00:00Z',updated_at:'2026-10-20T00:00:00Z'};
const query=vi.fn(),release=vi.fn(),authorize=vi.fn();
const pool={query,connect:async()=>({query,release})} as unknown as Pool;
let stored:{project_id:string;revision:number;model_id:string|null;model_pin:string|null;dimension?:number|null}|undefined;
beforeEach(()=>{
    vi.resetAllMocks();stored=undefined;authorize.mockResolvedValue(undefined);
    query.mockImplementation(async(sql:string,params:unknown[]=[])=>{
        if(sql.startsWith('SELECT id FROM projects'))return {rows:[{id:'prj-own'}]};
        if(sql.startsWith('SELECT * FROM project_embedding_settings'))return {rows:stored?[stored]:[]};
        if(sql.startsWith('SELECT * FROM model_catalog'))return {rows:[card]};
        if(sql.startsWith('SELECT 1 FROM project_models'))return {rows:[{}]};
        if(sql.startsWith('INSERT INTO project_embedding_settings')){stored={project_id:String(params[0]),revision:Number(params[1]),model_id:params[2] as string|null,model_pin:params[3] as string|null,dimension:params[4] as number|null};return {rows:[stored]};}
        return {rows:[]};
    });
});
describe('Выбор embedding-модели проекта с CAS и аудитом',()=>{
    it('Первый выбор фиксирует технический SHA, профиль и аудит, не выполняя inference',async()=>{
        const saved=await new ProjectEmbeddingRepository(pool).update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize);
        expect(saved).toMatchObject({revision:1,model:{id:card.id},modelPin:expect.stringMatching(/^[a-f0-9]{64}$/),profile:{provider:'openai',dimension:2560}});
        expect(saved.profile?.model).toBe(`neurocenter/${card.id}/sha256/${saved.modelPin}`);
        expect(authorize).toHaveBeenCalledOnce();expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
        expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO security_events'))).toHaveLength(1);
    });
    it('Имя, описание и ревизия карточки не меняют технический pin',()=>{
        const model={...descriptor,id:card.id,name:card.name,revision:1,createdAt:'now',updatedAt:'now'} as const;
        expect(projectEmbeddingPin(model)).toBe(projectEmbeddingPin({...model,name:'Новое имя',description:'Новое описание',revision:9}));
        expect(projectEmbeddingPin(model)).not.toBe(projectEmbeddingPin({...model,manifestSha256:'b'.repeat(64)}));
    });
    it('Потерянный ACK того же значения не создаёт новую ревизию и второй аудит',async()=>{
        const repo=new ProjectEmbeddingRepository(pool);await repo.update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize);
        query.mockClear();expect((await repo.update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize)).revision).toBe(1);
        expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO security_events'))).toBe(false);
    });
    it('Чужая ревизия и отзыв прав после ожидания блокировки не пишут новое значение',async()=>{
        stored={project_id:'prj-own',revision:2,model_id:null,model_pin:null};
        const repo=new ProjectEmbeddingRepository(pool);
        await expect(repo.update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize)).rejects.toMatchObject({status:409});
        authorize.mockRejectedValue(new Error('Доступ отозван'));
        await expect(repo.update('prj-own',{expectedRevision:2,modelId:card.id},'admin@example.test',2560,authorize)).rejects.toThrow('Доступ отозван');
        expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO project_embedding_settings'))).toBe(false);
    });
    it('Очистка сохраняет tombstone-ревизию и не возвращает старую модель по умолчанию',async()=>{
        const repo=new ProjectEmbeddingRepository(pool);await repo.update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize);
        expect(await repo.update('prj-own',{expectedRevision:1,modelId:null},'admin@example.test',2560,authorize)).toMatchObject({revision:2,model:null,modelPin:null,profile:null});
        expect(await repo.read('prj-own',2560)).toMatchObject({revision:2,model:null});
    });
    it.each(['unassigned','dimension','unpinned','vision'])('Несовместимый выбор %s не попадает в настройки',async scenario=>{
        const base=query.getMockImplementation()!;query.mockImplementation(async(sql:string,params:unknown[])=>{
            if(scenario==='unassigned'&&sql.startsWith('SELECT 1 FROM project_models'))return {rows:[]};
            if(sql.startsWith('SELECT * FROM model_catalog'))return {rows:[{...card,descriptor:{...descriptor,
                ...(scenario==='dimension'?{dimension:3}:{}),...(scenario==='unpinned'?{manifestSha256:null}:{}),...(scenario==='vision'?{capability:'vision'}:{})}}]};
            return base(sql,params);
        });
        await expect(new ProjectEmbeddingRepository(pool).update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize)).rejects.toMatchObject({status:409});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO project_embedding_settings'))).toBe(false);
    });
    it('Сбой аудита откатывает транзакцию выбора',async()=>{
        const base=query.getMockImplementation()!;query.mockImplementation(async(sql:string,params:unknown[])=>{if(sql.startsWith('INSERT INTO security_events'))throw Error('Аудит недоступен');return base(sql,params);});
        await expect(new ProjectEmbeddingRepository(pool).update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize)).rejects.toThrow('Аудит недоступен');
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
    });
    it.each(['assignment','manifest','removed','dimension'])('GET сохраняет выбранный pin и сообщает причину после изменения %s',async change=>{
        const repo=new ProjectEmbeddingRepository(pool);const selected=await repo.update('prj-own',{expectedRevision:0,modelId:card.id},'admin@example.test',2560,authorize);
        const base=query.getMockImplementation()!;query.mockImplementation(async(sql:string,params:unknown[])=>{
            if(change==='assignment'&&sql.startsWith('SELECT 1 FROM project_models'))return {rows:[]};
            if(change==='removed'&&sql.startsWith('SELECT * FROM model_catalog'))return {rows:[]};
            if(change==='manifest'&&sql.startsWith('SELECT * FROM model_catalog'))return {rows:[{...card,descriptor:{...descriptor,manifestSha256:'d'.repeat(64)}}]};
            return base(sql,params);
        });
        const value=await repo.read('prj-own',change==='dimension'?3:2560);
        expect(value).toMatchObject({revision:1,modelPin:selected.modelPin,profile:selected.profile,blocker:expect.any(String)});
        expect(value.model?.id??null).toBe(change==='removed'?null:card.id);
    });
});
